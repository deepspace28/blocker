const { EventEmitter } = require('events');
const crypto = require('crypto');
const store = require('./store');
const appBlocker = require('./appBlocker');

const TICK_MS = 15000;
const APP_ENFORCE_MS = 4000;

// Actual site-blocking enforcement lives in the browser extension (see
// extension/), which polls this app's local status API and redirects
// blocked navigations to its own block page. This engine just owns the
// session's state (start/end/mode/domains/hard-mode) and native app
// killing, which needs no admin permission and no browser involvement.
class SessionEngine extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
    this._appTimer = null;
  }

  getState() {
    // Required lazily: statusServer reads the store too, and pulling it in
    // at module load would make the two files circular.
    const statusServer = require('./statusServer');
    return {
      activeSession: store.get('activeSession'),
      blocklist: store.get('blocklist'),
      allowlist: store.get('allowlist'),
      appBlocklist: store.get('appBlocklist'),
      schedules: store.get('schedules'),
      history: store.get('history'),
      pace: store.get('pace'),
      paceEvents: store.get('paceEvents'),
      extensionConnected: statusServer.isExtensionConnected(),
    };
  }

  /**
   * Record one Pace decision reported by the extension: you either sat
   * through the delay and went on, or you backed out. Deliberately does not
   * go through emitState() — a pace decision changes no enforcement state,
   * and bumping the status version would make every browser rebuild its
   * rules for a stat.
   * @param {{ time: number, host: string, action: 'through'|'back' }} evt
   */
  recordPaceEvent(evt) {
    const events = store.get('paceEvents');
    events.unshift(evt);
    store.set('paceEvents', events.slice(0, 500));
    this.emit('paceStats', evt);
  }

  emitState() {
    this.emit('state', this.getState());
  }

  /**
   * Start a focus session.
   * @param {object} opts
   * @param {'block'|'allow'} [opts.mode] 'block' = block the given/blocklist
   *   domains; 'allow' = "Lock the Internet" — block everything except the
   *   given/allowlist domains.
   * @param {string[]} [opts.domains]
   * @param {string[]} [opts.apps] native app process names to also kill
   * @param {number} opts.durationMinutes
   * @param {boolean} opts.hard
   * @param {'manual'|'schedule'} [opts.source]
   * @param {string} [opts.scheduleId]
   */
  async start(opts) {
    const existing = store.get('activeSession');
    if (existing) {
      throw new Error('A focus session is already active.');
    }

    const mode = opts.mode === 'allow' ? 'allow' : 'block';
    const defaultList = mode === 'allow' ? store.get('allowlist') : store.get('blocklist');
    const domains = opts.domains && opts.domains.length ? opts.domains : defaultList;
    const apps = opts.apps && opts.apps.length ? opts.apps : store.get('appBlocklist');

    const startTime = Date.now();
    const endTime = startTime + Math.max(1, opts.durationMinutes) * 60 * 1000;

    const session = {
      id: crypto.randomUUID(),
      source: opts.source || 'manual',
      scheduleId: opts.scheduleId || null,
      startTime,
      endTime,
      hard: !!opts.hard,
      mode,
      domains,
      apps,
    };

    store.set('activeSession', session);
    this._startAppEnforcement(session.apps);
    this.emitState();
    return session;
  }

  /**
   * Attempt to stop the active session early. Refuses if hard mode and time remains.
   */
  async stopEarly() {
    const session = store.get('activeSession');
    if (!session) return { stopped: false, reason: 'no-active-session' };

    if (session.hard && Date.now() < session.endTime) {
      return { stopped: false, reason: 'hard-mode-locked' };
    }

    await this._endSession(session, { endedEarly: Date.now() < session.endTime });
    return { stopped: true };
  }

  async _endSession(session, { endedEarly }) {
    this._stopAppEnforcement();
    store.set('activeSession', null);

    const history = store.get('history');
    history.unshift({
      id: session.id,
      startTime: session.startTime,
      endTime: Date.now(),
      plannedEndTime: session.endTime,
      hard: session.hard,
      mode: session.mode,
      domains: session.domains,
      apps: session.apps,
      endedEarly,
      source: session.source,
    });
    store.set('history', history.slice(0, 500));

    if (session.scheduleId) {
      const schedules = store.get('schedules');
      const sched = schedules.find((s) => s.id === session.scheduleId);
      if (sched) {
        sched.lastWindowKey = this._windowKey(sched, new Date());
        store.set('schedules', schedules);
      }
    }

    this.emitState();
  }

  _startAppEnforcement(apps) {
    this._stopAppEnforcement();
    if (!apps || !apps.length) return;
    appBlocker.enforce(apps).catch(() => {});
    this._appTimer = setInterval(() => {
      appBlocker.enforce(apps).catch(() => {});
    }, APP_ENFORCE_MS);
  }

  _stopAppEnforcement() {
    if (this._appTimer) clearInterval(this._appTimer);
    this._appTimer = null;
  }

  _windowKey(schedule, now) {
    return `${now.toDateString()}|${schedule.id}|${schedule.start}`;
  }

  _scheduleMatchesNow(schedule, now) {
    if (!schedule.enabled) return false;
    const [startH, startM] = schedule.start.split(':').map(Number);
    const [endH, endM] = schedule.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (endMinutes > startMinutes) {
      const day = now.getDay();
      if (!schedule.days.includes(day)) return false;
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    // overnight window (e.g. 22:00 - 06:00)
    if (nowMinutes >= startMinutes) {
      return schedule.days.includes(now.getDay());
    }
    if (nowMinutes >= endMinutes) {
      return false;
    }
    const previousDay = (now.getDay() + 6) % 7;
    return schedule.days.includes(previousDay);
  }

  _scheduleEndTimestamp(schedule, now) {
    const [endH, endM] = schedule.end.split(':').map(Number);
    const end = new Date(now);
    end.setHours(endH, endM, 0, 0);
    if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
    return end.getTime();
  }

  async tick() {
    const session = store.get('activeSession');
    const now = new Date();

    if (session) {
      if (Date.now() >= session.endTime) {
        await this._endSession(session, { endedEarly: false });
      }
      return;
    }

    const schedules = store.get('schedules');
    for (const schedule of schedules) {
      if (!this._scheduleMatchesNow(schedule, now)) continue;
      const windowKey = this._windowKey(schedule, now);
      if (schedule.lastWindowKey === windowKey) continue; // already ran/handled this window
      if (schedule.skippedWindowKey === windowKey) continue; // user stopped it early this window

      const endTime = this._scheduleEndTimestamp(schedule, now);
      const durationMinutes = Math.max(1, Math.round((endTime - Date.now()) / 60000));
      const mode = schedule.mode === 'allow' ? 'allow' : 'block';
      const defaultList = mode === 'allow' ? store.get('allowlist') : store.get('blocklist');
      const domains = schedule.domains && schedule.domains.length ? schedule.domains : defaultList;

      try {
        await this.start({
          domains,
          apps: schedule.apps,
          durationMinutes,
          hard: !!schedule.hard,
          mode,
          source: 'schedule',
          scheduleId: schedule.id,
        });
      } catch (err) {
        // another session already active; try again next tick
      }
      break;
    }
  }

  /**
   * Called once at app launch. If a session was active when the app last
   * closed (or the machine restarted), resume it — the browser extension
   * will pick the still-active session back up on its next status poll,
   * which is what makes hard mode survive a restart.
   */
  async restoreOnLaunch() {
    const session = store.get('activeSession');
    if (!session) return;

    if (Date.now() >= session.endTime) {
      await this._endSession(session, { endedEarly: false });
      return;
    }

    this._startAppEnforcement(session.apps);
  }

  startTicking() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch(() => {});
    }, TICK_MS);
  }

  stopTicking() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = new SessionEngine();

const { EventEmitter } = require('events');
const crypto = require('crypto');
const store = require('./store');
const hostsBlocker = require('./hostsBlocker');

const TICK_MS = 15000;

class SessionEngine extends EventEmitter {
  constructor() {
    super();
    this._timer = null;
  }

  getState() {
    return {
      activeSession: store.get('activeSession'),
      blocklist: store.get('blocklist'),
      schedules: store.get('schedules'),
      history: store.get('history'),
    };
  }

  emitState() {
    this.emit('state', this.getState());
  }

  /**
   * Start a focus session.
   * @param {object} opts
   * @param {string[]} opts.domains
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
    const domains = opts.domains && opts.domains.length ? opts.domains : store.get('blocklist');
    const startTime = Date.now();
    const endTime = startTime + Math.max(1, opts.durationMinutes) * 60 * 1000;

    const session = {
      id: crypto.randomUUID(),
      source: opts.source || 'manual',
      scheduleId: opts.scheduleId || null,
      startTime,
      endTime,
      hard: !!opts.hard,
      domains,
    };

    await hostsBlocker.applyBlock(domains);
    store.set('activeSession', session);
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
    await hostsBlocker.removeBlock();
    store.set('activeSession', null);

    const history = store.get('history');
    history.unshift({
      id: session.id,
      startTime: session.startTime,
      endTime: Date.now(),
      plannedEndTime: session.endTime,
      hard: session.hard,
      domains: session.domains,
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

  _windowKey(schedule, now) {
    return `${now.toDateString()}|${schedule.id}|${schedule.start}`;
  }

  _scheduleMatchesNow(schedule, now) {
    if (!schedule.enabled) return false;
    const day = now.getDay();
    if (!schedule.days.includes(day)) return false;
    const [startH, startM] = schedule.start.split(':').map(Number);
    const [endH, endM] = schedule.end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (endMinutes > startMinutes) {
      return nowMinutes >= startMinutes && nowMinutes < endMinutes;
    }
    // overnight window (e.g. 22:00 - 06:00)
    return nowMinutes >= startMinutes || nowMinutes < endMinutes;
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
      const domains = schedule.domains && schedule.domains.length ? schedule.domains : store.get('blocklist');

      try {
        await this.start({
          domains,
          durationMinutes,
          hard: !!schedule.hard,
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
   * closed (or the machine restarted), re-assert the block and keep the
   * countdown going — this is what makes hard mode survive a restart.
   */
  async restoreOnLaunch() {
    const session = store.get('activeSession');
    if (!session) {
      // Defensive: if hosts file still has our managed block but we have no
      // record of an active session (e.g. store was cleared), clean it up.
      if (hostsBlocker.isCurrentlyBlocked()) {
        try {
          await hostsBlocker.removeBlock();
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }

    if (Date.now() >= session.endTime) {
      await this._endSession(session, { endedEarly: false });
      return;
    }

    try {
      await hostsBlocker.applyBlock(session.domains);
    } catch (_) {
      // If we can't get elevation on launch, the hosts file may already
      // still contain the block from before the restart, so this is
      // non-fatal; the session state itself is preserved either way.
    }
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

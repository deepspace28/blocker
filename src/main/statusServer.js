// A tiny localhost-only API the browser extension talks to. Bound to
// 127.0.0.1, so it's never reachable from the network — no authentication
// and, crucially, no admin/elevation of any kind is required.
//
// Endpoints:
//   GET  /status            — current session state, returns immediately
//   GET  /events?since=<v>  — long-poll: holds the connection open until the
//                             session state actually changes, so the
//                             extension learns about a session starting
//                             within milliseconds instead of on a slow poll.
//                             That delay was the reason a freshly-started
//                             session let the first page load through.
//   GET  /pace/stats        — today's pace tally, for the delay screen
//   POST /pace/event        — the extension reporting a pace decision
const http = require('http');
const fs = require('fs');
const { EventEmitter } = require('events');
const store = require('./store');

const PORT = 38219;
const HEARTBEAT_TIMEOUT_MS = 90000;
const LONG_POLL_TIMEOUT_MS = 25000;

class StatusServer extends EventEmitter {
  constructor() {
    super();
    this._server = null;
    this._version = 1;
    this._waiters = [];
    this._lastHeartbeat = 0;
    this._connected = false;
    this._connectionTimer = null;
  }

  /** Pace config as the extension needs it: the domain fallback is resolved
   *  here so the extension never has to know about the blocklist. */
  buildPacePayload() {
    const pace = store.get('pace') || {};
    const domains = pace.domains && pace.domains.length ? pace.domains : store.get('blocklist');
    return {
      enabled: !!pace.enabled,
      delaySeconds: Number(pace.delaySeconds) || 15,
      passMinutes: Number(pace.passMinutes) || 5,
      domains: pace.enabled ? domains : [],
    };
  }

  buildPayload() {
    const session = store.get('activeSession');
    if (!session) {
      return {
        version: this._version,
        active: false,
        mode: null,
        domains: [],
        hard: false,
        endTime: null,
        pace: this.buildPacePayload(),
      };
    }
    return {
      version: this._version,
      active: true,
      mode: session.mode,
      domains: session.domains,
      hard: session.hard,
      endTime: session.endTime,
      pace: this.buildPacePayload(),
    };
  }

  /** Called whenever session state changes; releases any held long-polls. */
  notifyChanged() {
    this._version += 1;
    const waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      this._sendJson(waiter.res, this.buildPayload());
    }
  }

  isExtensionConnected() {
    return Date.now() - this._lastHeartbeat < HEARTBEAT_TIMEOUT_MS;
  }

  _recordHeartbeat() {
    this._lastHeartbeat = Date.now();
    if (!this._connected) {
      this._connected = true;
      this.emit('connection', true);
    }
  }

  _sendJson(res, payload) {
    if (res.writableEnded) return;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(payload));
  }

  _handleEvents(req, res, url) {
    const since = Number(url.searchParams.get('since'));
    if (!Number.isFinite(since) || since !== this._version) {
      // Extension is behind (or asking for the first time) — answer now.
      this._sendJson(res, this.buildPayload());
      return;
    }

    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      this._waiters = this._waiters.filter((w) => w !== waiter);
      this._sendJson(res, this.buildPayload());
    }, LONG_POLL_TIMEOUT_MS);

    this._waiters.push(waiter);
    req.on('close', () => {
      clearTimeout(waiter.timer);
      this._waiters = this._waiters.filter((w) => w !== waiter);
    });
  }

  /** Today's pace tally, so the delay screen can show you your own pattern
   *  ("you've turned back 3 of 4 times today") rather than just a timer. */
  _paceStatsToday() {
    const today = new Date().toDateString();
    const events = store.get('paceEvents') || [];
    let paused = 0;
    let turnedBack = 0;
    for (const evt of events) {
      if (new Date(evt.time).toDateString() !== today) continue;
      paused += 1;
      if (evt.action === 'back') turnedBack += 1;
    }
    return { paused, turnedBack };
  }

  _readJsonBody(req) {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 4096) raw = raw.slice(0, 4096); // it's a two-field object
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    });
  }

  async _handlePaceEvent(req, res) {
    const body = await this._readJsonBody(req);
    if (!body || (body.action !== 'through' && body.action !== 'back')) {
      res.writeHead(400);
      res.end();
      return;
    }
    this.emit('paceEvent', {
      time: Date.now(),
      host: String(body.host || '').slice(0, 253),
      action: body.action,
    });
    this._sendJson(res, { ok: true });
  }

  /** Injected by main.js so this module stays free of Electron imports. */
  setManagedInstallContext(context) {
    this._managed = context; // { crxPath, extensionId, version }
  }

  _serveUpdateManifest(res) {
    if (!this._managed) {
      res.writeHead(503);
      res.end('managed install not prepared');
      return;
    }
    const { extensionId, version } = this._managed;
    const xml =
      `<?xml version='1.0' encoding='UTF-8'?>\n` +
      `<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n` +
      `  <app appid='${extensionId}'>\n` +
      `    <updatecheck codebase='http://127.0.0.1:${PORT}/focuslock.crx' version='${version}' />\n` +
      `  </app>\n` +
      `</gupdate>\n`;
    res.setHeader('Content-Type', 'text/xml');
    res.setHeader('Cache-Control', 'no-store');
    res.end(xml);
  }

  _serveCrx(res) {
    if (!this._managed || !fs.existsSync(this._managed.crxPath)) {
      res.writeHead(404);
      res.end('crx not built');
      return;
    }
    res.setHeader('Content-Type', 'application/x-chrome-extension');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(this._managed.crxPath).pipe(res);
  }

  start() {
    if (this._server) return;

    this._server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

      if (url.searchParams.get('client') === 'extension') {
        this._recordHeartbeat();
      }

      // A JSON POST from the extension is a cross-origin request, so the
      // browser preflights it first.
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === '/pace/event' && req.method === 'POST') {
        this._handlePaceEvent(req, res);
        return;
      }
      if (url.pathname === '/pace/stats') {
        this._sendJson(res, this._paceStatsToday());
        return;
      }

      if (url.pathname === '/status') {
        this._sendJson(res, this.buildPayload());
        return;
      }
      if (url.pathname === '/events') {
        this._handleEvents(req, res, url);
        return;
      }
      // Managed-install endpoints: the browser's policy engine fetches the
      // update manifest from here and then downloads the signed .crx, which
      // is what installs the extension without the user touching
      // chrome://extensions.
      if (url.pathname === '/update.xml') {
        this._serveUpdateManifest(res);
        return;
      }
      if (url.pathname === '/focuslock.crx') {
        this._serveCrx(res);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    this._server.listen(PORT, '127.0.0.1');

    // Watch for the extension going away (browser closed, extension
    // disabled) so the desktop app can surface that instead of silently
    // pretending everything is enforced.
    this._connectionTimer = setInterval(() => {
      const connected = this.isExtensionConnected();
      if (connected !== this._connected) {
        this._connected = connected;
        this.emit('connection', connected);
      }
    }, 5000);
  }

  stop() {
    if (this._connectionTimer) clearInterval(this._connectionTimer);
    this._connectionTimer = null;
    for (const waiter of this._waiters) clearTimeout(waiter.timer);
    this._waiters = [];
    if (this._server) this._server.close();
    this._server = null;
  }
}

module.exports = new StatusServer();
module.exports.PORT = PORT;

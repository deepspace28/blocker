// A tiny localhost-only API the browser extension talks to. Bound to
// 127.0.0.1, so it's never reachable from the network — no authentication
// and, crucially, no admin/elevation of any kind is required.
//
// Two endpoints:
//   GET /status            — current session state, returns immediately
//   GET /events?since=<v>  — long-poll: holds the connection open until the
//                            session state actually changes, so the
//                            extension learns about a session starting
//                            within milliseconds instead of on a slow poll.
//                            That delay was the reason a freshly-started
//                            session let the first page load through.
const http = require('http');
const fs = require('fs');
const { EventEmitter } = require('events');
const store = require('./store');

const PORT = 38219;
const HEARTBEAT_TIMEOUT_MS = 90000;
const LONG_POLL_TIMEOUT_MS = 25000;
// Browser-extension pages only. Extension service workers holding a
// host permission for 127.0.0.1 bypass CORS entirely, so this is really
// just for the popup and block pages.
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\//i;

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
      };
    }
    return {
      version: this._version,
      active: true,
      mode: session.mode,
      domains: session.domains,
      hard: session.hard,
      endTime: session.endTime,
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
      // The wildcard here let *any* page the user browsed read this endpoint,
      // which exposes the whole blocklist plus whether a hard-mode session is
      // running — and let those pages occupy long-poll slots. Only the
      // extension needs cross-origin access; ordinary web origins are
      // refused outright so they can't sit in the waiter list either.
      const origin = req.headers.origin;
      if (origin) {
        if (!EXTENSION_ORIGIN.test(origin)) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Vary', 'Origin');

      const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

      if (url.searchParams.get('client') === 'extension') {
        this._recordHeartbeat();
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

    // Answer every held long-poll before closing. Dropping the waiters
    // without replying left the extension blocked on a socket that would
    // never produce a response — it sat there until its own timeout instead
    // of falling back to short polling, so it stopped tracking session state
    // exactly when the app was going away.
    const waiters = this._waiters;
    this._waiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      this._sendJson(waiter.res, this.buildPayload());
    }

    const server = this._server;
    this._server = null;
    if (!server) return;
    server.close();
    // Those sockets are idle the moment their response flushes, but would
    // otherwise sit out keepAliveTimeout still holding the port.
    setImmediate(() => {
      if (server.closeIdleConnections) server.closeIdleConnections();
    });
  }
}

module.exports = new StatusServer();
module.exports.PORT = PORT;

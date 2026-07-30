// A tiny read-only local API the browser extension polls to find out
// whether a session is active and what it should block. Bound to
// 127.0.0.1 only — never reachable from the network — so it needs no
// authentication and, crucially, no admin/elevation of any kind.
const http = require('http');
const store = require('./store');

const PORT = 38219;
let server = null;

function buildStatusPayload() {
  const session = store.get('activeSession');
  if (!session) {
    return { active: false, mode: null, domains: [], hard: false, endTime: null };
  }
  return {
    active: true,
    mode: session.mode,
    domains: session.domains,
    hard: session.hard,
    endTime: session.endTime,
  };
}

function start() {
  if (server) return;
  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(buildStatusPayload()));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(PORT, '127.0.0.1');
}

function stop() {
  if (!server) return;
  server.close();
  server = null;
}

module.exports = { start, stop, PORT };

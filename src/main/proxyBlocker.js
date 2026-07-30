// "Lock the Internet" mode: instead of blocking a list of sites, this blocks
// *everything except* an allowlist. A hosts file can't express that (it can
// only redirect specific names), so this runs a tiny local HTTP/HTTPS proxy
// that only forwards requests to allowed hosts, and points the OS at it as
// the system proxy for the duration of the session.
const http = require('http');
const net = require('net');

const PROXY_PORT = 38217;

let server = null;
let currentAllowlist = [];

function setAllowlist(domains) {
  currentAllowlist = (domains || []).map((d) => d.toLowerCase().trim()).filter(Boolean);
}

function hostAllowed(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase();
  return currentAllowlist.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

function blockedPage(hostname) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Blocked by FocusLock</title>
  <style>body{font-family:sans-serif;background:#141a21;color:#e8eef7;display:flex;align-items:center;
  justify-content:center;height:100vh;margin:0}div{text-align:center}</style></head>
  <body><div><h1>🔒 Blocked</h1><p><strong>${hostname}</strong> isn't on your allowlist.</p>
  <p>FocusLock is in "Lock the Internet" mode.</p></div></body></html>`;
}

function startProxyServer() {
  if (server) return;

  server = http.createServer((req, res) => {
    const hostHeader = req.headers.host || '';
    const hostname = hostHeader.split(':')[0];
    if (!hostAllowed(hostname)) {
      res.writeHead(403, { 'Content-Type': 'text/html' });
      res.end(blockedPage(hostname));
      return;
    }

    const target = new URL(req.url, `http://${hostHeader}`);
    const proxyReq = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: req.method,
        headers: req.headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', () => res.destroy());
    req.pipe(proxyReq);
  });

  // HTTPS goes through CONNECT tunneling — we only inspect the hostname
  // (SNI-equivalent via the CONNECT target), never the encrypted traffic.
  server.on('connect', (req, clientSocket, head) => {
    const [hostname, port] = req.url.split(':');
    if (!hostAllowed(hostname)) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const serverSocket = net.connect(Number(port) || 443, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => serverSocket.destroy());
  });

  server.listen(PROXY_PORT, '127.0.0.1');
}

function stopProxyServer() {
  if (!server) return;
  server.close();
  server = null;
}

module.exports = {
  PROXY_PORT,
  setAllowlist,
  startProxyServer,
  stopProxyServer,
  isRunning: () => !!server,
};

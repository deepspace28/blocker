// Packs the extension into a signed .crx so it can be force-installed via
// managed policy, which is how the user gets the extension without ever
// opening chrome://extensions. Chromium itself does the packing (the
// `--pack-extension` flag), so we don't have to hand-roll CRX3 signing —
// and a Chromium browser is guaranteed present, since that's what we're
// installing into.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crx = require('./crx');

const WINDOWS_CANDIDATES = [
  ['Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
  ['Google Chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  ['Microsoft Edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
  ['Microsoft Edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
  ['Brave', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
];

const MAC_CANDIDATES = [
  ['Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  ['Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ['Brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
];

const LINUX_CANDIDATES = [
  ['Google Chrome', '/usr/bin/google-chrome'],
  ['Google Chrome', '/usr/bin/google-chrome-stable'],
  ['Chromium', '/usr/bin/chromium'],
  ['Chromium', '/usr/bin/chromium-browser'],
  ['Microsoft Edge', '/usr/bin/microsoft-edge'],
  ['Brave', '/usr/bin/brave-browser'],
];

function candidates() {
  if (process.platform === 'win32') {
    const extra = [];
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      extra.push(['Google Chrome', path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe')]);
      extra.push(['Brave', path.join(localAppData, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe')]);
    }
    return [...WINDOWS_CANDIDATES, ...extra];
  }
  if (process.platform === 'darwin') return MAC_CANDIDATES;
  return LINUX_CANDIDATES;
}

/** All Chromium browsers we can find on this machine. */
function findBrowsers() {
  const seen = new Set();
  const found = [];
  for (const [name, exe] of candidates()) {
    if (seen.has(exe)) continue;
    seen.add(exe);
    if (fs.existsSync(exe)) found.push({ name, path: exe });
  }
  // Allow an explicit override for unusual installs.
  if (process.env.FOCUSLOCK_BROWSER && fs.existsSync(process.env.FOCUSLOCK_BROWSER)) {
    found.unshift({ name: 'Custom', path: process.env.FOCUSLOCK_BROWSER });
  }
  return found;
}

function sourceDir(app) {
  // In a packaged build the extension ships inside the asar-unpacked
  // resources; in development it's just the repo folder.
  const packaged = path.join(process.resourcesPath || '', 'extension');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'extension');
}

function run(exe, args) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { timeout: 90000 }, (err, stdout, stderr) => {
      // --pack-extension exits non-zero on some builds even when it wrote
      // the .crx, so the caller checks for the file rather than the code.
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/**
 * Pack the extension with our stable key. Returns the .crx path.
 * The extension ID is derived from that key, so it never changes between
 * rebuilds — which matters, because the policy entry is keyed by ID.
 */
async function packExtension(app) {
  const browsers = findBrowsers();
  if (!browsers.length) {
    throw new Error(
      'No Chromium-based browser found (Chrome, Edge, or Brave). ' +
      'Install one, or set FOCUSLOCK_BROWSER to its executable path.'
    );
  }

  const key = crx.ensureKey(app);
  const src = sourceDir(app);
  if (!fs.existsSync(path.join(src, 'manifest.json'))) {
    throw new Error(`Extension source not found at ${src}`);
  }

  // Chromium writes <dir>.crx alongside the source dir, which may sit in a
  // read-only install location — so pack from a scratch copy instead.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'focuslock-pack-'));
  const stage = path.join(work, 'extension');
  fs.cpSync(src, stage, { recursive: true });

  let lastErr = null;
  for (const browser of browsers) {
    const result = await run(browser.path, [
      `--pack-extension=${stage}`,
      `--pack-extension-key=${key}`,
      '--no-sandbox',
    ]);
    const produced = path.join(work, 'extension.crx');
    if (fs.existsSync(produced)) {
      const dest = crx.crxPath(app);
      fs.copyFileSync(produced, dest);
      fs.rmSync(work, { recursive: true, force: true });
      return { crxPath: dest, packedBy: browser.name };
    }
    lastErr = (result.stderr || result.stdout || (result.err && result.err.message) || '').trim();
  }

  fs.rmSync(work, { recursive: true, force: true });
  throw new Error(`Could not pack the extension. Last output: ${lastErr || '(none)'}`);
}

function extensionVersion(app) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(sourceDir(app), 'manifest.json'), 'utf8')
  );
  return manifest.version;
}

module.exports = { findBrowsers, packExtension, sourceDir, extensionVersion };

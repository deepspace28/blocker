// Cross-platform hosts-file blocker.
// Blocking is done by redirecting domains to 127.0.0.1 inside a clearly
// marked, managed block in the OS hosts file. Writing the hosts file
// requires elevated privileges, so we shell out via sudo-prompt, which
// pops the native OS admin/password prompt (Touch ID/Keychain on macOS,
// UAC on Windows, pkexec/polkit on Linux).
const fs = require('fs');
const os = require('os');
const path = require('path');
const sudo = require('sudo-prompt');

const MARK_START = '# === FocusLock managed block (do not edit below) ===';
const MARK_END = '# === FocusLock managed block end ===';

function getHostsPath() {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

function readHosts() {
  try {
    return fs.readFileSync(getHostsPath(), 'utf8');
  } catch (err) {
    return '';
  }
}

function stripManagedBlock(content) {
  const startIdx = content.indexOf(MARK_START);
  const endIdx = content.indexOf(MARK_END);
  if (startIdx === -1 || endIdx === -1) return content;
  const before = content.slice(0, startIdx);
  const after = content.slice(endIdx + MARK_END.length);
  return (before + after).replace(/\n{3,}/g, '\n\n');
}

function buildManagedBlock(domains) {
  const lines = [MARK_START];
  const seen = new Set();
  for (const raw of domains) {
    const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    lines.push(`127.0.0.1 ${domain}`);
    lines.push(`127.0.0.1 www.${domain}`);
  }
  lines.push(MARK_END);
  return lines.join('\n') + '\n';
}

function isCurrentlyBlocked() {
  return readHosts().includes(MARK_START);
}

function getElevatedCopyCommand(tmpPath, hostsPath) {
  if (process.platform === 'win32') {
    return `copy /Y "${tmpPath}" "${hostsPath}" && ipconfig /flushdns`;
  }
  if (process.platform === 'darwin') {
    return `cp "${tmpPath}" "${hostsPath}" && dscacheutil -flushcache; killall -HUP mDNSResponder || true`;
  }
  // linux
  return `cp "${tmpPath}" "${hostsPath}" && (systemd-resolve --flush-caches || resolvectl flush-caches || true)`;
}

function writeHostsElevated(newContent) {
  return new Promise((resolve, reject) => {
    const hostsPath = getHostsPath();
    const tmpPath = path.join(os.tmpdir(), `focuslock-hosts-${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, newContent, 'utf8');

    const command = getElevatedCopyCommand(tmpPath, hostsPath);
    const options = { name: 'FocusLock' };

    sudo.exec(command, options, (error, stdout, stderr) => {
      try {
        fs.unlinkSync(tmpPath);
      } catch (_) {
        /* best effort cleanup */
      }
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function applyBlock(domains) {
  const current = readHosts();
  const stripped = stripManagedBlock(current);
  const block = buildManagedBlock(domains);
  const newContent = `${stripped.trimEnd()}\n\n${block}`;
  await writeHostsElevated(newContent);
}

async function removeBlock() {
  const current = readHosts();
  if (!current.includes(MARK_START)) return;
  const stripped = stripManagedBlock(current);
  await writeHostsElevated(stripped);
}

module.exports = {
  getHostsPath,
  applyBlock,
  removeBlock,
  isCurrentlyBlocked,
};

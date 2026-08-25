// Cross-platform native-app blocking: periodically lists running processes
// and force-kills any whose executable name matches a blocked app, so the
// app can't stay open (or gets closed again within a few seconds if
// relaunched) during a session.
const { exec } = require('child_process');
const path = require('path');

// A blocklist entry shorter than this is only ever matched exactly. "steam"
// should still catch "steamwebhelper", but letting a 2-3 character entry
// extend to any process that merely starts with it is how you end up killing
// half the machine.
const MIN_PREFIX_MATCH_LEN = 4;

function run(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

async function listProcesses() {
  if (process.platform === 'win32') {
    const stdout = await run('tasklist /FO CSV /NH');
    return stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const cols = line.split('","').map((c) => c.replace(/^"|"$/g, ''));
        return { pid: Number(cols[1]), name: cols[0] };
      })
      .filter((p) => Number.isFinite(p.pid));
  }

  const stdout = await run('ps -axo pid=,comm=');
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(' ');
      if (idx === -1) return null;
      const pid = Number(line.slice(0, idx));
      const name = line.slice(idx + 1).trim();
      return Number.isFinite(pid) ? { pid, name } : null;
    })
    .filter(Boolean);
}

function baseName(name) {
  // Strip the directory first (ps can report a full path, and Windows uses
  // backslashes), then the extension — doing it the other way round left
  // "C:\Apps\Discord.exe" as a full path that could never match anything.
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|app)$/, '');
}

/** The name of the binary we are ourselves running as, so a blocklist entry
 *  can never make FocusLock terminate its own helper processes and take the
 *  enforcement loop down with them. */
function selfName() {
  return baseName(path.basename(process.execPath));
}

function nameMatches(procName, target) {
  if (procName === target) return true;
  return target.length >= MIN_PREFIX_MATCH_LEN && procName.startsWith(target);
}

async function killProcess(pid) {
  if (process.platform === 'win32') {
    await run(`taskkill /PID ${pid} /F`);
  } else {
    await run(`kill -9 ${pid}`);
  }
}

/**
 * @param {string[]} blockedApps app names as they appear in Task
 *   Manager/Activity Monitor/`ps`, e.g. "Discord", "Steam.exe".
 */
async function enforce(blockedApps) {
  if (!blockedApps || !blockedApps.length) return;
  const targets = blockedApps.map((a) => baseName(a)).filter(Boolean);
  if (!targets.length) return;

  const processes = await listProcesses();
  const currentPid = process.pid;
  const self = selfName();
  for (const proc of processes) {
    if (proc.pid === currentPid) continue;
    const name = baseName(proc.name);
    // Electron runs its GPU/renderer/utility children under this same
    // executable name on different PIDs; skipping only our own PID left them
    // killable.
    if (name === self) continue;
    const match = targets.some((t) => nameMatches(name, t));
    if (match) {
      try {
        await killProcess(proc.pid);
      } catch (_) {
        /* best effort */
      }
    }
  }
}

module.exports = { enforce, listProcesses, baseName, nameMatches };

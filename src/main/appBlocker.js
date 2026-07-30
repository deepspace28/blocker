// Cross-platform native-app blocking: periodically lists running processes
// and force-kills any whose executable name matches a blocked app, so the
// app can't stay open (or gets closed again within a few seconds if
// relaunched) during a session.
const { exec } = require('child_process');

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
  return name.toLowerCase().replace(/\.exe$/, '').replace(/^.*\//, '');
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
  for (const proc of processes) {
    if (proc.pid === currentPid) continue;
    const name = baseName(proc.name);
    const match = targets.some((t) => name === t || name.includes(t));
    if (match) {
      try {
        await killProcess(proc.pid);
      } catch (_) {
        /* best effort */
      }
    }
  }
}

module.exports = { enforce, listProcesses };

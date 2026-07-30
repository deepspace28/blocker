// Best-effort OS proxy toggling so the local allowlist proxy actually
// intercepts traffic. macOS uses `networksetup` (no admin needed for the
// current user's own network service). Windows edits the per-user WinINet
// registry keys and asks WinINet to reload them. Linux only reliably covers
// GNOME (`gsettings`) — other desktop environments/browsers with their own
// proxy settings aren't covered, which is a real limitation, not a bug.
const { exec } = require('child_process');
const os = require('os');

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function getActiveMacNetworkService() {
  const stdout = await run('networksetup -listallnetworkservices');
  const lines = stdout.split('\n').slice(1).map((l) => l.trim()).filter(Boolean);
  const candidates = lines.filter((l) => !l.startsWith('*'));
  return candidates[0] || null;
}

async function enable(port) {
  if (process.platform === 'darwin') {
    const service = await getActiveMacNetworkService();
    if (!service) throw new Error('Could not find an active network service.');
    await run(`networksetup -setwebproxy "${service}" 127.0.0.1 ${port}`);
    await run(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${port}`);
    await run(`networksetup -setwebproxystate "${service}" on`);
    await run(`networksetup -setsecurewebproxystate "${service}" on`);
    return { platform: 'darwin', service };
  }

  if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    await run(`reg add "${key}" /v ProxyEnable /t REG_DWORD /d 1 /f`);
    await run(`reg add "${key}" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`);
    await refreshWindowsProxySettings();
    return { platform: 'win32' };
  }

  // linux (GNOME)
  await run("gsettings set org.gnome.system.proxy mode 'manual'");
  await run(`gsettings set org.gnome.system.proxy.http host '127.0.0.1'`);
  await run(`gsettings set org.gnome.system.proxy.http port ${port}`);
  await run(`gsettings set org.gnome.system.proxy.https host '127.0.0.1'`);
  await run(`gsettings set org.gnome.system.proxy.https port ${port}`);
  return { platform: 'linux' };
}

async function disable(context) {
  if (process.platform === 'darwin') {
    const service = (context && context.service) || (await getActiveMacNetworkService());
    if (!service) return;
    await run(`networksetup -setwebproxystate "${service}" off`);
    await run(`networksetup -setsecurewebproxystate "${service}" off`);
    return;
  }

  if (process.platform === 'win32') {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    await run(`reg add "${key}" /v ProxyEnable /t REG_DWORD /d 0 /f`);
    await refreshWindowsProxySettings();
    return;
  }

  await run("gsettings set org.gnome.system.proxy mode 'none'");
}

async function refreshWindowsProxySettings() {
  const script =
    '$sig=\'[DllImport("wininet.dll")]public static extern bool InternetSetOption(IntPtr hInternet,int dwOption,IntPtr lpBuffer,int lpdwBufferLength);\';' +
    '$t=Add-Type -MemberDefinition $sig -Name Wininet -Namespace PInvoke -PassThru;' +
    '$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null;' +
    '$t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)|Out-Null;';
  await run(`powershell -NoProfile -Command "${script}"`);
}

module.exports = { enable, disable, platform: os.platform() };

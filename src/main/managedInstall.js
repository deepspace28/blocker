// Installs the extension the way an IT department would: via managed
// browser policy. The user approves once (a single UAC / admin prompt),
// and from then on the extension is installed automatically in every
// supported Chromium browser — no chrome://extensions, no Developer mode.
//
// Force-installed extensions also can't be disabled or removed by the
// user, which is what makes hard mode actually hard.
//
// Everything here is reversible: `uninstall()` removes exactly what
// `install()` wrote.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 38219;

// Policy directories per browser, per platform. Chromium reads managed
// policy from these locations at startup.
const LINUX_POLICY_DIRS = [
  ['Google Chrome', '/etc/opt/chrome/policies/managed'],
  ['Chromium', '/etc/chromium/policies/managed'],
  ['Microsoft Edge', '/etc/opt/edge/policies/managed'],
  ['Brave', '/etc/brave/policies/managed'],
];

const MAC_POLICY_DOMAINS = [
  ['Google Chrome', 'com.google.Chrome'],
  ['Microsoft Edge', 'com.microsoft.Edge'],
  ['Brave', 'com.brave.Browser'],
];

const WINDOWS_POLICY_KEYS = [
  ['Google Chrome', 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome'],
  ['Microsoft Edge', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge'],
  ['Brave', 'HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave'],
];

const POLICY_FILENAME = 'focuslock.json';

function updateUrl() {
  return `http://127.0.0.1:${PORT}/update.xml`;
}

/** The ExtensionSettings policy value, identical across platforms. */
function policyObject(extensionId) {
  return {
    ExtensionSettings: {
      [extensionId]: {
        installation_mode: 'force_installed',
        update_url: updateUrl(),
        toolbar_pin: 'force_pinned',
      },
    },
  };
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120000 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? err.code : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || err?.message || ''),
      });
    });
  });
}

// --- Windows -----------------------------------------------------------

function windowsScript(extensionId, { remove }) {
  // Chromium reads ExtensionSettings on Windows as registry SUBKEYS — one
  // per extension id, with each setting as a string value underneath.
  // Writing a JSON blob at the parent as well would collide with this
  // structure, so we use only the documented subkey layout.
  const lines = ['$ErrorActionPreference = "Stop"'];

  for (const [name, key] of WINDOWS_POLICY_KEYS) {
    const extKey = `Registry::${key}\\ExtensionSettings\\${extensionId}`;
    if (remove) {
      lines.push(`if (Test-Path "${extKey}") { Remove-Item -Path "${extKey}" -Recurse -Force }`);
    } else {
      lines.push(`New-Item -Path "${extKey}" -Force | Out-Null`);
      lines.push(`Set-ItemProperty -Path "${extKey}" -Name "installation_mode" -Value "force_installed"`);
      lines.push(`Set-ItemProperty -Path "${extKey}" -Name "update_url" -Value "${updateUrl()}"`);
      lines.push(`Set-ItemProperty -Path "${extKey}" -Name "toolbar_pin" -Value "force_pinned"`);
    }
    lines.push(`Write-Output "${remove ? 'removed' : 'configured'}: ${name}"`);
  }
  return lines.join('\n');
}

async function windowsApply(extensionId, { remove }) {
  const script = windowsScript(extensionId, { remove });
  const file = path.join(os.tmpdir(), `focuslock-policy-${Date.now()}.ps1`);
  fs.writeFileSync(file, script, 'utf8');

  // Self-elevate: this is the single admin prompt the whole design costs.
  const outer =
    `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden ` +
    `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${file}'`;

  const result = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer]);
  try {
    fs.unlinkSync(file);
  } catch (_) { /* best effort */ }

  if (!result.ok) {
    throw new Error(
      result.stderr.includes('canceled') || result.stderr.includes('cancelled')
        ? 'Administrator approval was declined.'
        : `Policy update failed: ${result.stderr.trim() || 'unknown error'}`
    );
  }
  return WINDOWS_POLICY_KEYS.map(([name]) => name);
}

// --- macOS -------------------------------------------------------------

async function macApply(extensionId, { remove }) {
  const applied = [];
  for (const [name, domain] of MAC_POLICY_DOMAINS) {
    const plist = `/Library/Managed Preferences/${domain}.plist`;
    const script = remove
      ? `/usr/libexec/PlistBuddy -c "Delete :ExtensionSettings:${extensionId}" "${plist}" 2>/dev/null || true`
      : [
          `/usr/bin/defaults write "${plist.replace(/\.plist$/, '')}" ExtensionSettings -dict-add ${extensionId} ` +
            `'{"installation_mode"="force_installed";"update_url"="${updateUrl()}";"toolbar_pin"="force_pinned";}'`,
        ].join(' ');
    const result = await run('/usr/bin/osascript', [
      '-e',
      `do shell script "${script.replace(/"/g, '\\"')}" with administrator privileges`,
    ]);
    if (result.ok) applied.push(name);
  }
  if (!applied.length) throw new Error('Administrator approval was declined, or no supported browser is installed.');
  return applied;
}

// --- Linux -------------------------------------------------------------

async function linuxApply(extensionId, { remove }) {
  const commands = [];
  for (const [, dir] of LINUX_POLICY_DIRS) {
    const file = path.join(dir, POLICY_FILENAME);
    if (remove) {
      commands.push(`rm -f '${file}'`);
    } else {
      const json = JSON.stringify(policyObject(extensionId));
      commands.push(`mkdir -p '${dir}' && printf '%s' '${json}' > '${file}'`);
    }
  }
  const script = commands.join(' ; ');

  // pkexec gives the graphical auth prompt; sudo -n is a non-interactive
  // fallback for machines already configured for it.
  let result = await run('pkexec', ['sh', '-c', script]);
  if (!result.ok) result = await run('sudo', ['-n', 'sh', '-c', script]);
  if (!result.ok) {
    throw new Error(`Administrator approval was declined or unavailable: ${result.stderr.trim()}`);
  }
  return LINUX_POLICY_DIRS.map(([name]) => name);
}

// --- public API --------------------------------------------------------

async function install(extensionId) {
  if (process.platform === 'win32') return windowsApply(extensionId, { remove: false });
  if (process.platform === 'darwin') return macApply(extensionId, { remove: false });
  return linuxApply(extensionId, { remove: false });
}

async function uninstall(extensionId) {
  if (process.platform === 'win32') return windowsApply(extensionId, { remove: true });
  if (process.platform === 'darwin') return macApply(extensionId, { remove: true });
  return linuxApply(extensionId, { remove: true });
}

/** Best-effort read of whether our policy is currently in place. */
async function isInstalled(extensionId) {
  if (process.platform === 'win32') {
    const key = `HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionSettings\\${extensionId}`;
    const result = await run('reg', ['query', key]);
    return result.ok;
  }
  if (process.platform === 'linux') {
    return LINUX_POLICY_DIRS.some(([, dir]) => fs.existsSync(path.join(dir, POLICY_FILENAME)));
  }
  if (process.platform === 'darwin') {
    return MAC_POLICY_DOMAINS.some(([, domain]) =>
      fs.existsSync(`/Library/Managed Preferences/${domain}.plist`)
    );
  }
  return false;
}

module.exports = { install, uninstall, isInstalled, policyObject, updateUrl, POLICY_FILENAME };

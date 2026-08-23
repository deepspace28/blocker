const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const sessionEngine = require('./sessionEngine');
const presetBlocklists = require('./presetBlocklists');
const statusServer = require('./statusServer');
const crx = require('./crx');
const extensionPacker = require('./extensionPacker');
const managedInstall = require('./managedInstall');

function cleanDomain(raw) {
  return String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

let mainWindow = null;
let tray = null;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 420,
    minHeight: 600,
    title: 'FocusLock',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.on('close', (event) => {
    const session = store.get('activeSession');
    if (!isQuitting) {
      // Always minimize to tray instead of quitting, so a hard-mode session
      // can't be escaped just by closing the window.
      event.preventDefault();
      mainWindow.hide();
      if (session && session.hard) {
        tray && tray.displayBalloon && tray.displayBalloon({
          title: 'FocusLock',
          content: 'Focus session still running in the background.',
        });
      }
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray32.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('FocusLock');

  const buildMenu = () => {
    const session = store.get('activeSession');
    return Menu.buildFromTemplate([
      {
        label: session ? `Session active (${session.hard ? 'hard mode' : 'flexible'})` : 'No active session',
        enabled: false,
      },
      { type: 'separator' },
      {
        label: 'Open FocusLock',
        click: () => {
          mainWindow.show();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit FocusLock',
        click: () => {
          // The before-quit handler enforces the hard-mode guard and shows
          // the warning dialog if a locked session is still running.
          app.quit();
        },
      },
    ]);
  };

  tray.setContextMenu(buildMenu());
  sessionEngine.on('state', () => tray.setContextMenu(buildMenu()));

  tray.on('click', () => {
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
}

function registerIpcHandlers() {
  ipcMain.handle('state:get', () => sessionEngine.getState());

  ipcMain.handle('blocklist:add', (_e, domain) => {
    const list = store.get('blocklist');
    const clean = cleanDomain(domain);
    if (clean && !list.includes(clean)) {
      list.push(clean);
      store.set('blocklist', list);
      sessionEngine.emitState();
    }
    return store.get('blocklist');
  });

  ipcMain.handle('blocklist:remove', (_e, domain) => {
    const list = store.get('blocklist').filter((d) => d !== domain);
    store.set('blocklist', list);
    sessionEngine.emitState();
    return list;
  });

  ipcMain.handle('allowlist:add', (_e, domain) => {
    const list = store.get('allowlist');
    const clean = cleanDomain(domain);
    if (clean && !list.includes(clean)) {
      list.push(clean);
      store.set('allowlist', list);
      sessionEngine.emitState();
    }
    return store.get('allowlist');
  });

  ipcMain.handle('allowlist:remove', (_e, domain) => {
    const list = store.get('allowlist').filter((d) => d !== domain);
    store.set('allowlist', list);
    sessionEngine.emitState();
    return list;
  });

  ipcMain.handle('appBlocklist:add', (_e, appName) => {
    const list = store.get('appBlocklist');
    const clean = String(appName).trim();
    if (clean && !list.includes(clean)) {
      list.push(clean);
      store.set('appBlocklist', list);
      sessionEngine.emitState();
    }
    return store.get('appBlocklist');
  });

  ipcMain.handle('appBlocklist:remove', (_e, appName) => {
    const list = store.get('appBlocklist').filter((a) => a !== appName);
    store.set('appBlocklist', list);
    sessionEngine.emitState();
    return list;
  });

  // --- pace (soft friction) ---

  ipcMain.handle('pace:update', (_e, patch) => {
    const pace = { ...store.get('pace'), ...patch };
    pace.enabled = !!pace.enabled;
    pace.delaySeconds = clamp(Number(pace.delaySeconds) || 15, 3, 120);
    pace.passMinutes = clamp(Number(pace.passMinutes) || 5, 1, 120);
    store.set('pace', pace);
    sessionEngine.emitState();
    return store.get('pace');
  });

  ipcMain.handle('pace:add', (_e, domain) => {
    const pace = store.get('pace');
    const clean = cleanDomain(domain);
    if (clean && !pace.domains.includes(clean)) {
      pace.domains.push(clean);
      store.set('pace', pace);
      sessionEngine.emitState();
    }
    return store.get('pace');
  });

  ipcMain.handle('pace:remove', (_e, domain) => {
    const pace = store.get('pace');
    pace.domains = pace.domains.filter((d) => d !== domain);
    store.set('pace', pace);
    sessionEngine.emitState();
    return store.get('pace');
  });

  ipcMain.handle('presets:list', () => presetBlocklists);

  ipcMain.handle('presets:apply', (_e, categoryName) => {
    const domains = presetBlocklists[categoryName];
    if (!domains) return store.get('blocklist');
    const list = store.get('blocklist');
    for (const d of domains) {
      if (!list.includes(d)) list.push(d);
    }
    store.set('blocklist', list);
    sessionEngine.emitState();
    return list;
  });

  ipcMain.handle('session:start', async (_e, opts) => {
    return sessionEngine.start(opts);
  });

  ipcMain.handle('session:stop', async () => {
    return sessionEngine.stopEarly();
  });

  ipcMain.handle('schedule:add', (_e, schedule) => {
    const schedules = store.get('schedules');
    schedules.push({
      id: crypto.randomUUID(),
      name: schedule.name || 'Untitled schedule',
      days: schedule.days || [],
      start: schedule.start,
      end: schedule.end,
      enabled: schedule.enabled !== false,
      hard: !!schedule.hard,
      mode: schedule.mode === 'allow' ? 'allow' : 'block',
      domains: schedule.domains || null,
      apps: schedule.apps || null,
      lastWindowKey: null,
      skippedWindowKey: null,
    });
    store.set('schedules', schedules);
    sessionEngine.emitState();
    return schedules;
  });

  ipcMain.handle('schedule:update', (_e, { id, patch }) => {
    const schedules = store.get('schedules');
    const idx = schedules.findIndex((s) => s.id === id);
    if (idx !== -1) {
      schedules[idx] = { ...schedules[idx], ...patch };
      store.set('schedules', schedules);
      sessionEngine.emitState();
    }
    return schedules;
  });

  ipcMain.handle('schedule:remove', (_e, id) => {
    const schedules = store.get('schedules').filter((s) => s.id !== id);
    store.set('schedules', schedules);
    sessionEngine.emitState();
    return schedules;
  });

  // --- automatic (managed) extension install ---

  ipcMain.handle('setup:info', async () => {
    const extensionId = crx.extensionId(app);
    return {
      extensionId,
      browsers: extensionPacker.findBrowsers().map((b) => b.name),
      policyInstalled: await managedInstall.isInstalled(extensionId),
      extensionConnected: statusServer.isExtensionConnected(),
      launchAtLogin: app.getLoginItemSettings().openAtLogin,
    };
  });

  ipcMain.handle('setup:install', async () => {
    const extensionId = crx.extensionId(app);
    // Pack first: if this fails there's no point prompting for admin.
    const { packedBy } = await extensionPacker.packExtension(app);
    store.set('settings', {
      ...store.get('settings'),
      packedExtensionVersion: extensionPacker.extensionVersion(app),
    });
    prepareManagedInstall();

    // Start at login too, so blocking is in force without the user
    // remembering to open the app.
    app.setLoginItemSettings(loginItemOptions(true));

    // The policy is already in place, so there is nothing left that needs
    // administrator rights. Re-packing the extension above is the whole job.
    // Prompting again would train the user to click through UAC for nothing,
    // which is the opposite of what a one-time approval is for.
    if (await managedInstall.isInstalled(extensionId)) {
      return { extensionId, packedBy, browsers: [], alreadyInstalled: true };
    }

    const browsers = await managedInstall.install(extensionId);
    return { extensionId, packedBy, browsers, alreadyInstalled: false };
  });

  ipcMain.handle('setup:uninstall', async () => {
    const extensionId = crx.extensionId(app);
    const browsers = await managedInstall.uninstall(extensionId);
    app.setLoginItemSettings({ openAtLogin: false });
    return { browsers };
  });

  ipcMain.handle('setup:setLaunchAtLogin', (_e, enabled) => {
    app.setLoginItemSettings(loginItemOptions(enabled));
    return app.getLoginItemSettings().openAtLogin;
  });
}

/**
 * Start at login. Packaged, `process.execPath` is FocusLock itself and
 * Electron does the right thing. Running from source it's Electron's own
 * binary, which with no app path just opens Electron's default window —
 * so say which app to run.
 */
function loginItemOptions(enabled) {
  const options = { openAtLogin: !!enabled, openAsHidden: true };
  if (!app.isPackaged) {
    options.path = process.execPath;
    options.args = [app.getAppPath()];
  }
  return options;
}

/**
 * Keep the packed .crx in step with the extension this build ships.
 *
 * Packing needs no elevation — only writing browser policy does, and that
 * happened once during setup. The policy already points the browser at
 * /focuslock.crx, so refreshing that file here is what lets an app update
 * reach the browser without ever asking for administrator approval again.
 */
async function ensurePackedExtensionIsCurrent() {
  let wanted;
  try {
    wanted = extensionPacker.extensionVersion(app);
  } catch (err) {
    return; // No extension source — the Setup tab reports the real error.
  }

  const settings = store.get('settings');
  if (settings.packedExtensionVersion === wanted && fs.existsSync(crx.crxPath(app))) return;

  try {
    await extensionPacker.packExtension(app);
    store.set('settings', { ...settings, packedExtensionVersion: wanted });
    prepareManagedInstall();
  } catch (err) {
    // No Chromium browser found, or it refused to pack. Not fatal: the
    // browser keeps running whatever version it already has.
  }
}

/** Tell the status server where the packed .crx lives so the browser's
 *  policy engine can fetch it. Safe to call before the crx exists — the
 *  endpoint 404s until it's built. */
function prepareManagedInstall() {
  try {
    statusServer.setManagedInstallContext({
      crxPath: crx.crxPath(app),
      extensionId: crx.extensionId(app),
      version: extensionPacker.extensionVersion(app),
    });
  } catch (err) {
    // Missing extension source in a broken install; the Setup tab will
    // surface the real error when the user tries to install.
  }
}

async function startApp() {
  registerIpcHandlers();
  createWindow();
  createTray();
  prepareManagedInstall();
  statusServer.start();

  // Not awaited: packing shells out to a browser and takes a second or two,
  // and nothing else depends on it finishing.
  ensurePackedExtensionIsCurrent();

  await sessionEngine.restoreOnLaunch();

  const pushState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state:update', sessionEngine.getState());
    }
  };

  sessionEngine.on('state', () => {
    // Release any long-polling extension immediately, so a session start or
    // stop reaches the browser in milliseconds rather than on the next poll.
    statusServer.notifyChanged();
    pushState();
  });

  // Surface extension connect/disconnect in the UI, so "nothing is being
  // blocked because the extension isn't installed" is visible rather than
  // a silent no-op.
  statusServer.on('connection', pushState);

  // Pace decisions come in from the browser, not the UI. Record them and
  // refresh the window only — no version bump, so browsers don't rebuild
  // their blocking rules every time you hit a delay screen.
  statusServer.on('paceEvent', (evt) => sessionEngine.recordPaceEvent(evt));
  sessionEngine.on('paceStats', pushState);

  sessionEngine.startTicking();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
}

// FocusLock lives in the tray, so clicking its icon again is the normal way
// to reopen it — and that must not start a second copy fighting the first
// for port 38219. Show the window that's already running instead.
//
// app.exit rather than app.quit: quitting is deliberately blocked during a
// hard-mode session, and that guard belongs to the instance doing the
// blocking, not to this one.
if (app.requestSingleInstanceLock()) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(startApp);
} else {
  app.exit(0);
}

app.on('before-quit', (event) => {
  if (isQuitting) return; // already cleared through the guarded tray quit path
  const active = store.get('activeSession');
  if (active && active.hard && Date.now() < active.endTime) {
    event.preventDefault();
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Hard mode is active',
      message: "You can't quit FocusLock while a hard-mode session is running.",
    });
    return;
  }
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // Keep running in the tray on all platforms; user quits via tray menu.
});

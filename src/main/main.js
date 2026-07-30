const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const sessionEngine = require('./sessionEngine');
const presetBlocklists = require('./presetBlocklists');

function cleanDomain(raw) {
  return String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
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
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  createWindow();
  createTray();

  await sessionEngine.restoreOnLaunch();
  sessionEngine.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('state:update', state);
    }
  });
  sessionEngine.startTicking();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow.show();
  });
});

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

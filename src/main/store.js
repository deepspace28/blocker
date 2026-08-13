const Store = require('electron-store');

const store = new Store({
  name: 'focuslock-data',
  defaults: {
    blocklist: [
      'facebook.com',
      'instagram.com',
      'twitter.com',
      'x.com',
      'reddit.com',
      'youtube.com',
      'tiktok.com',
    ],
    allowlist: [], // domains allowed through in 'allow' (Lock the Internet) mode
    appBlocklist: [], // native app process names to kill during a session, e.g. "Discord", "Steam.exe"
    // schedule: { id, name, days: [0-6], start: 'HH:MM', end: 'HH:MM', enabled, hard,
    //             mode: 'block'|'allow', domains: [] | null (null = use blocklist/allowlist), apps: [] }
    schedules: [],
    // activeSession: { id, source: 'manual'|'schedule', scheduleId, startTime, endTime, hard,
    //                  mode: 'block'|'allow', domains, apps, proxyContext }
    activeSession: null,
    // history: { id, startTime, endTime, plannedEndTime, hard, mode, domains, endedEarly, source }
    history: [],
    settings: {
      launchAtLogin: false,
    },
  },
});

module.exports = store;

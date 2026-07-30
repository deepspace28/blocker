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
    schedules: [], // { id, name, days: [0-6], start: 'HH:MM', end: 'HH:MM', enabled, hard, domains: [] | null (null = all blocklist) }
    activeSession: null, // { id, source: 'manual'|'schedule', scheduleId, startTime, endTime, hard, domains }
    history: [], // { id, startTime, endTime, plannedEndTime, hard, domains, endedEarly, source }
    settings: {
      launchAtLogin: false,
    },
  },
});

module.exports = store;

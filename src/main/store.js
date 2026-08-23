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
    // Pace — soft friction instead of a hard block. Paced sites aren't
    // blocked; they get a delay screen first, and going through buys a
    // short pass. Runs whether or not a session is active.
    // domains: [] means "use the blocklist", mirroring how sessions
    // fall back to it.
    pace: {
      enabled: false,
      delaySeconds: 15,
      passMinutes: 5,
      domains: [],
    },
    // paceEvents: { time, host, action: 'through'|'back' } — newest first
    paceEvents: [],
    settings: {
      launchAtLogin: false,
      // Version of the extension the packed .crx was built from. Lets the
      // app notice its own update and re-pack without an admin prompt.
      packedExtensionVersion: null,
    },
  },
});

module.exports = store;

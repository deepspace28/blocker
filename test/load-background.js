// Loads extension/background.js into a sandbox with a stubbed `chrome`, so
// its decision logic can be tested without a browser. Top-level function
// declarations land on the sandbox global, which is how the tests reach
// shouldBlock, matchPaceDomain, buildRules and friends.
//
// Nothing here mutates the extension source: if the sandbox needs a new
// stub, the extension started calling a new browser API.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function listenerStub() {
  return { addListener() {} };
}

function stubChrome() {
  return {
    runtime: {
      getURL: (file) => `chrome-extension://focuslocktestid/${file}`,
      onInstalled: listenerStub(),
      onStartup: listenerStub(),
      onMessage: listenerStub(),
    },
    alarms: { create() {}, onAlarm: listenerStub() },
    tabs: { update: async () => {}, query: async () => [], onUpdated: listenerStub() },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    webNavigation: { onBeforeNavigate: listenerStub() },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {},
    },
    storage: { session: { get: async () => ({}), set: async () => {} } },
  };
}

function loadBackground() {
  const file = path.join(__dirname, '..', 'extension', 'background.js');
  const sandbox = {
    chrome: stubChrome(),
    // A promise that never settles. background.js starts polling the desktop
    // app as soon as it loads; this parks that loop instead of letting it
    // retry forever and hold the test process open.
    fetch: () => new Promise(() => {}),
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    URL,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: 'background.js' });
  return sandbox;
}

/** An idle status payload, shaped exactly like the one /status returns. */
function statusPayload(overrides = {}) {
  return {
    version: 1,
    active: false,
    mode: null,
    domains: [],
    hard: false,
    endTime: null,
    pace: { enabled: false, delaySeconds: 15, passMinutes: 5, domains: [] },
    ...overrides,
  };
}

module.exports = { loadBackground, statusPayload };

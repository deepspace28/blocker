// Enforces FocusLock sessions inside the browser.
//
// Two layers, deliberately:
//   1. declarativeNetRequest rules — the fast, steady-state blocker.
//   2. Direct tab redirection — a synchronous safety net using cached
//      session state. DNR rules are applied asynchronously, so a
//      navigation that starts before they land would otherwise slip
//      through; that race is exactly why a freshly-started session used
//      to let the first page load. Layer 2 closes it, and also handles
//      tabs that were already open when the session began.
const BASE = 'http://127.0.0.1:38219';
const STATUS_URL = `${BASE}/status?client=extension`;
const EVENTS_URL = `${BASE}/events?client=extension`;
const STATUS_HOSTS = new Set(['127.0.0.1:38219', 'localhost:38219']);
const RULE_ID_BASE = 1000;
const ALARM_NAME = 'focuslock-refresh';
const FALLBACK_POLL_MS = 2000;

const IDLE_STATUS = { version: 0, active: false, mode: null, domains: [], hard: false, endTime: null };

let cachedStatus = IDLE_STATUS;
let syncRunning = false;

// --- pure helpers -------------------------------------------------------

function normalizeDomain(domain) {
  return String(domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function domainFilter(domain) {
  return `||${normalizeDomain(domain)}^`;
}

function hostMatches(host, domain) {
  const d = normalizeDomain(domain);
  return host === d || host.endsWith(`.${d}`);
}

/** Decide whether a URL should be blocked under the given session state. */
function shouldBlock(rawUrl, status) {
  if (!status || !status.active) return false;
  if (!/^https?:/i.test(rawUrl)) return false; // never touch chrome://, extension pages, etc.

  let url;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    return false;
  }
  // FocusLock's own status endpoint must stay reachable, or the app can't
  // be diagnosed while "Lock the Internet" is running.
  if (STATUS_HOSTS.has(url.host)) return false;

  const host = url.hostname.toLowerCase();
  const listed = (status.domains || []).some((d) => hostMatches(host, d));
  return status.mode === 'allow' ? !listed : listed;
}

function buildRules(status) {
  if (!status.active || !Array.isArray(status.domains) || !status.domains.length) return [];

  const blockedUrl = chrome.runtime.getURL('blocked.html');
  const rules = [];
  let id = RULE_ID_BASE;

  // FocusLock's own status endpoint must stay reachable in BOTH modes, or
  // the app can't be diagnosed mid-session. Highest priority so it wins
  // over any blocklist entry; scoped to the exact port so it doesn't
  // exempt other local dev servers the user might be running.
  rules.push({
    id: id++,
    priority: 3,
    action: { type: 'allow' },
    condition: { urlFilter: '127.0.0.1:38219', resourceTypes: ['main_frame'] },
  });

  if (status.mode === 'allow') {
    for (const domain of status.domains) {
      rules.push({
        id: id++,
        priority: 2,
        action: { type: 'allow' },
        condition: { urlFilter: domainFilter(domain), resourceTypes: ['main_frame'] },
      });
    }
    rules.push({
      id: id++,
      priority: 1,
      action: { type: 'redirect', redirect: { url: blockedUrl } },
      condition: { resourceTypes: ['main_frame'] },
    });
  } else {
    for (const domain of status.domains) {
      rules.push({
        id: id++,
        priority: 1,
        action: { type: 'redirect', redirect: { url: blockedUrl } },
        condition: { urlFilter: domainFilter(domain), resourceTypes: ['main_frame'] },
      });
    }
  }
  return rules;
}

// --- enforcement --------------------------------------------------------

async function applyRules(status) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = buildRules(status);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    console.log(
      '[FocusLock] rules updated — active:', status.active,
      'mode:', status.mode,
      'rules:', addRules.length
    );
  } catch (err) {
    console.error('[FocusLock] updateDynamicRules failed:', err.message);
  }
}

function redirectTab(tabId) {
  chrome.tabs.update(tabId, { url: chrome.runtime.getURL('blocked.html') }).catch(() => {});
}

/** Sweep every open tab — catches tabs that were already open when the
 *  session started, which DNR rules alone never revisit. */
async function enforceOpenTabs(status) {
  if (!status.active) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (err) {
    return;
  }
  for (const tab of tabs) {
    if (tab.id != null && tab.url && shouldBlock(tab.url, status)) {
      redirectTab(tab.id);
    }
  }
}

function setBadge(status) {
  const text = status.active ? 'ON' : '';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#2fae66' }).catch(() => {});
}

async function applyStatus(status, { sweepTabs }) {
  const previous = cachedStatus;
  cachedStatus = status;
  setBadge(status);
  await applyRules(status);

  const becameActive = status.active && !previous.active;
  const listChanged = JSON.stringify(previous.domains) !== JSON.stringify(status.domains)
    || previous.mode !== status.mode;
  if (sweepTabs || becameActive || listChanged) {
    await enforceOpenTabs(status);
  }
}

async function fetchOnce(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function refreshNow({ sweepTabs = false } = {}) {
  try {
    const status = await fetchOnce(STATUS_URL);
    await applyStatus(status, { sweepTabs });
  } catch (err) {
    // App not running / unreachable. Keep whatever rules are already in
    // place rather than failing open, so a hard-mode block can't be lifted
    // just by closing the desktop app.
    console.warn('[FocusLock] cannot reach the desktop app —', err.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Keeps cached state fresh. Preferred path is the long-poll: the server
 *  holds the request open until session state actually changes, so a
 *  session start reaches us in milliseconds. If that isn't available (older
 *  app build, app not running), degrade to short polling rather than
 *  waiting on the 30s alarm — stale state means delayed blocking. */
async function syncLoop() {
  if (syncRunning) return;
  syncRunning = true;
  try {
    for (;;) {
      try {
        const status = await fetchOnce(`${EVENTS_URL}&since=${cachedStatus.version}`);
        await applyStatus(status, { sweepTabs: true });
      } catch (err) {
        await refreshNow();
        await sleep(FALLBACK_POLL_MS);
      }
    }
  } finally {
    syncRunning = false;
  }
}

function kick() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  refreshNow({ sweepTabs: true }).then(syncLoop);
}

// --- listeners ----------------------------------------------------------

chrome.runtime.onInstalled.addListener(kick);
chrome.runtime.onStartup.addListener(kick);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // Also revives the long-poll loop if the service worker was suspended.
  refreshNow().then(syncLoop);
});

// Synchronous safety net: decide from cached state before the navigation
// commits, so the very first request after a session starts is caught.
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (shouldBlock(details.url, cachedStatus)) {
    redirectTab(details.tabId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (shouldBlock(changeInfo.url, cachedStatus)) {
    redirectTab(tabId);
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'focuslock:getStatus') {
    sendResponse(cachedStatus);
    return true;
  }
  return undefined;
});

kick();

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
//
// Both layers handle two outcomes: a hard block (blocked.html) and Pace —
// a delay screen (pace.html) that lets you through afterwards for a while.
// A hard block always wins over Pace.
const BASE = 'http://127.0.0.1:38219';
const STATUS_URL = `${BASE}/status?client=extension`;
const EVENTS_URL = `${BASE}/events?client=extension`;
const PACE_EVENT_URL = `${BASE}/pace/event?client=extension`;
const STATUS_HOSTS = new Set(['127.0.0.1:38219', 'localhost:38219']);
const RULE_ID_BASE = 1000;
const ALARM_NAME = 'focuslock-refresh';
const FALLBACK_POLL_MS = 2000;
const PASSES_KEY = 'focuslock:passes';

const IDLE_PACE = { enabled: false, delaySeconds: 15, passMinutes: 5, domains: [] };
const IDLE_STATUS = {
  version: 0, active: false, mode: null, domains: [], hard: false, endTime: null, pace: IDLE_PACE,
};

let cachedStatus = IDLE_STATUS;
let syncRunning = false;
// Live Pace passes: { 'youtube.com': expiryTimestamp }. Kept in
// storage.session so a suspended service worker doesn't hand out a fresh
// delay screen mid-pass — and so closing the browser clears them.
let passes = {};

// --- pure helpers -------------------------------------------------------

function normalizeDomain(domain) {
  return String(domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function prunePasses(map, now = Date.now()) {
  const live = {};
  for (const [domain, expiry] of Object.entries(map || {})) {
    if (Number(expiry) > now) live[domain] = Number(expiry);
  }
  return live;
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

/**
 * Domains that should get a Pace delay right now.
 *
 * Three things take a domain off this list:
 *  - a live pass (you already sat through the delay);
 *  - the domain being hard-blocked by the running session, since a block
 *    beats friction and two competing redirect rules would be ambiguous;
 *  - a "Lock the Internet" session, where everything unlisted is blocked
 *    already and the allowlist is there precisely because you chose it.
 */
function paceDomainsFor(status, passMap = passes, now = Date.now()) {
  const pace = status && status.pace;
  if (!pace || !pace.enabled || !Array.isArray(pace.domains)) return [];
  if (status.active && status.mode === 'allow') return [];

  const blocked = new Set(
    status.active ? (status.domains || []).map(normalizeDomain) : []
  );
  const live = prunePasses(passMap, now);
  return pace.domains
    .map(normalizeDomain)
    .filter((d) => d && !blocked.has(d) && !live[d]);
}

/** The paced domain this URL falls under, or null if it should load normally. */
function matchPaceDomain(rawUrl, status, passMap = passes, now = Date.now()) {
  if (!/^https?:/i.test(rawUrl)) return null;
  if (shouldBlock(rawUrl, status)) return null; // a hard block wins

  let url;
  try {
    url = new URL(rawUrl);
  } catch (err) {
    return null;
  }
  if (STATUS_HOSTS.has(url.host)) return null;

  const host = url.hostname.toLowerCase();
  return paceDomainsFor(status, passMap, now).find((d) => hostMatches(host, d)) || null;
}

function buildRules(status, passMap = passes, now = Date.now()) {
  const paced = paceDomainsFor(status, passMap, now);
  if (!status.active || !Array.isArray(status.domains) || !status.domains.length) {
    return paced.length ? buildPaceRules(paced, RULE_ID_BASE) : [];
  }

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
        // Above the priority-1 Pace rules: if a domain somehow lands on both
        // lists (say `youtube.com` blocked and `m.youtube.com` paced), the
        // block is the one that must win.
        id: id++,
        priority: 2,
        action: { type: 'redirect', redirect: { url: blockedUrl } },
        condition: { urlFilter: domainFilter(domain), resourceTypes: ['main_frame'] },
      });
    }
  }
  rules.push(...buildPaceRules(paced, id));
  return rules;
}

/**
 * Redirect paced domains to the delay screen, carrying the URL you asked
 * for so the screen can send you on afterwards. `\0` is the whole matched
 * URL, which is why the pattern is anchored at both ends.
 */
function buildPaceRules(domains, startId) {
  const paceUrl = chrome.runtime.getURL('pace.html');
  let id = startId;
  return domains.map((domain) => ({
    id: id++,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${paceUrl}?u=\\0` } },
    condition: {
      regexFilter: `^https?://([a-z0-9-]+\\.)*${escapeRegex(domain)}(:\\d+)?(/.*)?$`,
      resourceTypes: ['main_frame'],
    },
  }));
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

/** The requested URL is appended raw, exactly as the DNR rule does it, so
 *  the delay screen only ever has to parse one shape. */
function paceTab(tabId, requestedUrl) {
  const url = `${chrome.runtime.getURL('pace.html')}?u=${requestedUrl}`;
  chrome.tabs.update(tabId, { url }).catch(() => {});
}

// --- pace passes --------------------------------------------------------

async function loadPasses() {
  try {
    const stored = await chrome.storage.session.get(PASSES_KEY);
    // Merge rather than replace: a pass granted while this read was in
    // flight is newer than what came back from storage.
    passes = prunePasses({ ...stored[PASSES_KEY], ...passes });
  } catch (err) {
    // Keep whatever is in memory.
  }
}

async function savePasses() {
  try {
    await chrome.storage.session.set({ [PASSES_KEY]: passes });
  } catch (err) {
    // Non-fatal: the pass still holds in memory for this worker's lifetime.
  }
}

/** Let this domain through for a while. Rules are rebuilt *before* this
 *  resolves — the delay screen navigates the moment it hears back, and a
 *  stale redirect rule would bounce it straight back to the delay screen. */
async function grantPass(domain) {
  const minutes = Number((cachedStatus.pace || IDLE_PACE).passMinutes) || 5;
  passes = prunePasses(passes);
  passes[domain] = Date.now() + minutes * 60 * 1000;
  await savePasses();
  await applyRules(cachedStatus);
  return passes[domain];
}

/** Report a Pace decision to the desktop app for the stats it keeps.
 *  Best-effort: the app may not be running, and that must not block you. */
function reportPaceEvent(host, action) {
  return fetch(PACE_EVENT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, action }),
  }).catch(() => {});
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
  loadPasses()
    .then(() => refreshNow({ sweepTabs: true }))
    .then(syncLoop);
}

// --- listeners ----------------------------------------------------------

chrome.runtime.onInstalled.addListener(kick);
chrome.runtime.onStartup.addListener(kick);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // Sweeping expired passes here is what puts the Pace redirect rules back
  // after a pass runs out; navigation-time checks already expire it exactly.
  const live = prunePasses(passes);
  if (Object.keys(live).length !== Object.keys(passes).length) {
    passes = live;
    savePasses();
  }
  // Also revives the long-poll loop if the service worker was suspended.
  refreshNow().then(syncLoop);
});

// Synchronous safety net: decide from cached state before the navigation
// commits, so the very first request after a session starts is caught.
// This layer is also what makes a pass expire on time — it re-checks the
// clock on every navigation, rather than waiting for rules to be rebuilt.
function enforceNavigation(tabId, url) {
  if (shouldBlock(url, cachedStatus)) {
    redirectTab(tabId);
    return;
  }
  if (matchPaceDomain(url, cachedStatus)) {
    paceTab(tabId, url);
  }
}

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  enforceNavigation(details.tabId, details.url);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  enforceNavigation(tabId, changeInfo.url);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return undefined;

  if (msg.type === 'focuslock:getStatus') {
    sendResponse(cachedStatus);
    return true;
  }

  // The delay screen ran out its countdown and you chose to go on.
  if (msg.type === 'focuslock:pacePass') {
    (async () => {
      // A delay screen left open outrun the service worker's idle timeout,
      // so this may be a worker that just woke up with no state. Without
      // the refresh the pass would be dropped on the floor and the site
      // paced all over again seconds later.
      if (!cachedStatus.version) await refreshNow();
      const domain = matchPaceDomain(msg.url, cachedStatus);
      reportPaceEvent(domain || String(msg.url || ''), 'through');
      // No domain means Pace was turned off or a pass is already live —
      // either way there's nothing left to grant.
      const until = domain ? await grantPass(domain) : null;
      sendResponse({ ok: true, until });
    })();
    return true;
  }

  // You turned back. This is the number worth counting.
  if (msg.type === 'focuslock:paceBack') {
    const domain = matchPaceDomain(msg.url, cachedStatus);
    reportPaceEvent(domain || String(msg.url || ''), 'back');
    sendResponse({ ok: true });
    return true;
  }

  return undefined;
});

kick();

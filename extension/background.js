// Polls the FocusLock desktop app's local, read-only status API and turns
// the current session into declarativeNetRequest rules — no host
// permissions prompts beyond the one-time install, no OS-level changes.
const STATUS_URL = 'http://127.0.0.1:38219/status';
const RULE_ID_BASE = 1000;
const ALARM_NAME = 'focuslock-refresh';

async function fetchStatus() {
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    // FocusLock app isn't running / unreachable — leave existing rules as
    // they are rather than failing open, so a hard-mode block doesn't
    // silently lift just because the status server hiccuped.
    return null;
  }
}

function domainFilter(domain) {
  return `||${domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}^`;
}

async function refreshRules() {
  const status = await fetchStatus();
  if (status === null) return;

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = [];

  if (status.active && Array.isArray(status.domains) && status.domains.length) {
    const blockedUrl = chrome.runtime.getURL('blocked.html');
    let id = RULE_ID_BASE;

    if (status.mode === 'allow') {
      for (const domain of status.domains) {
        addRules.push({
          id: id++,
          priority: 2,
          action: { type: 'allow' },
          condition: { urlFilter: domainFilter(domain), resourceTypes: ['main_frame'] },
        });
      }
      addRules.push({
        id: id++,
        priority: 1,
        action: { type: 'redirect', redirect: { url: blockedUrl } },
        condition: { resourceTypes: ['main_frame'] },
      });
    } else {
      for (const domain of status.domains) {
        addRules.push({
          id: id++,
          priority: 1,
          action: { type: 'redirect', redirect: { url: blockedUrl } },
          condition: { urlFilter: domainFilter(domain), resourceTypes: ['main_frame'] },
        });
      }
    }
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

function ensureAlarm() {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  refreshRules();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshRules();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshRules();
});

ensureAlarm();
refreshRules();

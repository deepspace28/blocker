// Regression tests for the extension's blocking decisions. Two of these
// cover bugs found by end-to-end testing: the first navigation after a
// session started used to load the real site, and tabs that were already
// open were never blocked at all. Both are decided by shouldBlock.
const test = require('node:test');
const assert = require('node:assert');
const { loadBackground, statusPayload } = require('./load-background');

const bg = loadBackground();

const blocking = (domains) => statusPayload({ active: true, mode: 'block', domains });
const locking = (domains) => statusPayload({ active: true, mode: 'allow', domains });

test('blocks a listed domain and its subdomains', () => {
  const status = blocking(['reddit.com']);
  assert.equal(bg.shouldBlock('https://reddit.com/r/all', status), true);
  assert.equal(bg.shouldBlock('https://old.reddit.com/', status), true);
});

test('leaves everything else alone in block mode', () => {
  const status = blocking(['reddit.com']);
  assert.equal(bg.shouldBlock('https://github.com/', status), false);
  // Not a subdomain — a different site that merely ends the same way.
  assert.equal(bg.shouldBlock('https://notreddit.com/', status), false);
});

test('Lock the Internet inverts the list', () => {
  const status = locking(['docs.google.com']);
  assert.equal(bg.shouldBlock('https://docs.google.com/document/1', status), false);
  assert.equal(bg.shouldBlock('https://reddit.com/', status), true);
});

test("FocusLock's own status endpoint stays reachable in both modes", () => {
  assert.equal(bg.shouldBlock('http://127.0.0.1:38219/status', locking([])), false);
  assert.equal(bg.shouldBlock('http://127.0.0.1:38219/status', blocking(['127.0.0.1'])), false);
});

test('never touches browser-internal or extension pages', () => {
  const status = locking([]);
  assert.equal(bg.shouldBlock('chrome://extensions', status), false);
  assert.equal(bg.shouldBlock('chrome-extension://abc/blocked.html', status), false);
});

test('blocks nothing when no session is running', () => {
  assert.equal(bg.shouldBlock('https://reddit.com/', statusPayload()), false);
});

test('block mode builds one redirect per domain, plus the status exemption', () => {
  const rules = bg.buildRules(blocking(['reddit.com', 'x.com']), {});
  assert.equal(rules.length, 3);
  assert.equal(rules[0].action.type, 'allow'); // the status endpoint
  assert.equal(rules.filter((r) => r.action.type === 'redirect').length, 2);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, 'rule ids must be unique');
});

test('allow mode builds an allow per domain and one catch-all redirect', () => {
  const rules = bg.buildRules(locking(['docs.google.com']), {});
  const catchAll = rules.filter((r) => r.action.type === 'redirect' && !r.condition.urlFilter);
  assert.equal(rules.filter((r) => r.action.type === 'allow').length, 2); // status + allowlist
  assert.equal(catchAll.length, 1);
  // The catch-all must be the lowest priority, or it would beat the allows.
  assert.ok(rules.filter((r) => r.action.type === 'allow').every((r) => r.priority > catchAll[0].priority));
});

test('no session and no pace means no rules at all', () => {
  assert.equal(bg.buildRules(statusPayload(), {}).length, 0);
});

// Pace: the delay screen instead of a wall. What matters here is when a
// site is paced and when it isn't — a live pass, a hard block, and Lock
// the Internet each take it out of scope for different reasons.
const test = require('node:test');
const assert = require('node:assert');
const { loadBackground, statusPayload } = require('./load-background');

const bg = loadBackground();

const MINUTE = 60 * 1000;
const NOW = 1700000000000;

function pacing(domains, overrides = {}) {
  return statusPayload({
    pace: { enabled: true, delaySeconds: 15, passMinutes: 5, domains },
    ...overrides,
  });
}

test('paces a listed domain and its subdomains', () => {
  const status = pacing(['youtube.com']);
  assert.equal(bg.matchPaceDomain('https://youtube.com/feed', status, {}, NOW), 'youtube.com');
  assert.equal(bg.matchPaceDomain('https://m.youtube.com/', status, {}, NOW), 'youtube.com');
  assert.equal(bg.matchPaceDomain('https://github.com/', status, {}, NOW), null);
});

test('paces nothing while Pace is switched off', () => {
  const status = statusPayload({
    pace: { enabled: false, delaySeconds: 15, passMinutes: 5, domains: ['youtube.com'] },
  });
  assert.equal(bg.matchPaceDomain('https://youtube.com/', status, {}, NOW), null);
});

test('a live pass lets the site through, and stops when it expires', () => {
  const status = pacing(['youtube.com']);
  const passes = { 'youtube.com': NOW + 5 * MINUTE };
  assert.equal(bg.matchPaceDomain('https://youtube.com/', status, passes, NOW), null);
  assert.equal(
    bg.matchPaceDomain('https://youtube.com/', status, passes, NOW + 5 * MINUTE + 1),
    'youtube.com',
    'the pass must stop letting you through the moment it runs out'
  );
});

test('a pass covers subdomains of the domain it was granted for', () => {
  const status = pacing(['youtube.com']);
  const passes = { 'youtube.com': NOW + MINUTE };
  assert.equal(bg.matchPaceDomain('https://m.youtube.com/', status, passes, NOW), null);
});

test('a hard block beats Pace', () => {
  // Same site on both lists: the running session blocks it outright, so it
  // must not be handed a "continue anyway" button.
  const status = pacing(['youtube.com'], {
    active: true, mode: 'block', domains: ['youtube.com'],
  });
  assert.equal(bg.shouldBlock('https://youtube.com/', status), true);
  assert.equal(bg.matchPaceDomain('https://youtube.com/', status, {}, NOW), null);
  assert.equal(bg.paceDomainsFor(status, {}, NOW).length, 0, 'no competing redirect rule');
});

test('Pace still covers sites the running session is not blocking', () => {
  const status = pacing(['youtube.com'], {
    active: true, mode: 'block', domains: ['reddit.com'],
  });
  assert.equal(bg.matchPaceDomain('https://youtube.com/', status, {}, NOW), 'youtube.com');
});

test('Lock the Internet turns Pace off entirely', () => {
  // Everything unlisted is already blocked, and the allowlist is allowed
  // precisely because it was chosen deliberately.
  const status = pacing(['youtube.com'], {
    active: true, mode: 'allow', domains: ['docs.google.com'],
  });
  assert.equal(bg.matchPaceDomain('https://docs.google.com/', status, {}, NOW), null);
  assert.equal(bg.paceDomainsFor(status, {}, NOW).length, 0);
});

test('the status endpoint is never paced', () => {
  const status = pacing(['127.0.0.1']);
  assert.equal(bg.matchPaceDomain('http://127.0.0.1:38219/status', status, {}, NOW), null);
});

test('pace rules redirect to the delay screen carrying the whole URL', () => {
  const rules = bg.buildRules(pacing(['youtube.com']), {}, NOW);
  assert.equal(rules.length, 1);
  const [rule] = rules;
  assert.ok(rule.action.redirect.regexSubstitution.endsWith('pace.html?u=\\0'));
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);

  // Anchored at both ends, so `\0` really is the entire URL.
  const pattern = new RegExp(rule.condition.regexFilter);
  const target = 'https://www.youtube.com/watch?v=abc&t=1';
  assert.equal(target.match(pattern)[0], target);
  assert.ok(pattern.test('https://youtube.com/'));
  assert.ok(!pattern.test('https://notyoutube.com/'), 'must not catch lookalike domains');
});

test('a passed domain gets no pace rule', () => {
  const rules = bg.buildRules(pacing(['youtube.com']), { 'youtube.com': NOW + MINUTE }, NOW);
  assert.equal(rules.length, 0);
});

test('pace rules never collide with blocking rule ids', () => {
  const status = pacing(['youtube.com'], { active: true, mode: 'block', domains: ['reddit.com'] });
  const rules = bg.buildRules(status, {}, NOW);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  // A block must outrank the pace redirect, whatever order they were built in.
  const block = rules.find((r) => r.condition.urlFilter && r.condition.urlFilter.includes('reddit'));
  const pace = rules.find((r) => r.condition.regexFilter);
  assert.ok(block.priority > pace.priority);
});

test('expired passes are pruned', () => {
  const pruned = bg.prunePasses({ 'a.com': NOW - 1, 'b.com': NOW + MINUTE }, NOW);
  assert.deepEqual(Object.keys(pruned), ['b.com']);
});

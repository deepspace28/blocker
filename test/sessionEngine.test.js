const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const sessionEnginePath = path.join(__dirname, '..', 'src', 'main', 'sessionEngine.js');
const storePath = path.join(__dirname, '..', 'src', 'main', 'store.js');
const appBlockerPath = path.join(__dirname, '..', 'src', 'main', 'appBlocker.js');

function loadSessionEngine() {
  delete require.cache[sessionEnginePath];
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: { get() { return []; }, set() {} },
  };
  require.cache[appBlockerPath] = {
    id: appBlockerPath,
    filename: appBlockerPath,
    loaded: true,
    exports: { enforce: async () => {} },
  };
  return require(sessionEnginePath);
}

const sessionEngine = loadSessionEngine();

test('same-day schedules match only on listed days', () => {
  const schedule = {
    enabled: true,
    days: [1, 3],
    start: '09:00',
    end: '17:00',
  };

  assert.equal(
    sessionEngine._scheduleMatchesNow(schedule, new Date('2026-08-31T10:00:00')),
    true
  );
  assert.equal(
    sessionEngine._scheduleMatchesNow(schedule, new Date('2026-09-01T10:00:00')),
    false
  );
});

test('overnight schedules stay active after midnight on the following day', () => {
  const schedule = {
    enabled: true,
    days: [0],
    start: '22:00',
    end: '06:00',
  };

  assert.equal(
    sessionEngine._scheduleMatchesNow(schedule, new Date('2026-08-30T23:30:00')),
    true
  );
  assert.equal(
    sessionEngine._scheduleMatchesNow(schedule, new Date('2026-08-31T01:30:00')),
    true
  );
  assert.equal(
    sessionEngine._scheduleMatchesNow(schedule, new Date('2026-08-31T07:00:00')),
    false
  );
});

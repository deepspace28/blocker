// The Pace delay screen: friction instead of a wall.
//
// You asked for a site you told FocusLock to slow you down on. Sit through
// a short countdown and you can go on — for a few minutes, then the pause
// comes back. The way out is the loud button; continuing is the quiet one.
const STATS_URL = 'http://127.0.0.1:38219/pace/stats?client=extension';
const RADIUS = 66;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const DEFAULT_PACE = { delaySeconds: 15, passMinutes: 5 };

const countEl = document.getElementById('count');
const dialEl = document.getElementById('dial-fill');
const hostEl = document.getElementById('host');
const subEl = document.getElementById('sub');
const backBtn = document.getElementById('back-btn');
const goBtn = document.getElementById('go-btn');
const tallyEl = document.getElementById('tally');

// The requested URL is appended raw (`?u=https://site/path?a=b`), so take
// everything after the first `?u=` rather than parsing query parameters —
// the URL carries its own `?` and `&`.
function requestedUrl() {
  const marker = location.href.indexOf('?u=');
  if (marker === -1) return null;
  const raw = location.href.slice(marker + 3);
  if (!/^https?:\/\//i.test(raw)) return null; // never follow javascript:, data:, …
  try {
    return new URL(raw).href;
  } catch (err) {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (err) {
    return 'this site';
  }
}

async function getPaceConfig() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'focuslock:getStatus' });
    const pace = (status && status.pace) || {};
    return {
      delaySeconds: Number(pace.delaySeconds) || DEFAULT_PACE.delaySeconds,
      passMinutes: Number(pace.passMinutes) || DEFAULT_PACE.passMinutes,
    };
  } catch (err) {
    return { ...DEFAULT_PACE };
  }
}

async function showTally() {
  try {
    const res = await fetch(STATS_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const { paused, turnedBack } = await res.json();
    if (!paused) return;
    tallyEl.textContent = `Today: ${paused} pause${paused === 1 ? '' : 's'} · ${turnedBack} turned back`;
  } catch (err) {
    // App isn't running — the screen works fine without the tally.
  }
}

function leave() {
  if (history.length > 1) {
    history.back();
    return;
  }
  // Nothing to go back to (you typed the address into a fresh tab).
  document.querySelector('.actions').remove();
  document.querySelector('.dial').remove();
  countEl.remove();
  document.querySelector('h1').textContent = 'Good call.';
  subEl.textContent = 'Close this tab whenever you like.';
}

function startCountdown(seconds, target) {
  const totalMs = seconds * 1000;
  const startedAt = Date.now();
  dialEl.style.strokeDasharray = String(CIRCUMFERENCE);

  const tick = () => {
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, totalMs - elapsed);
    countEl.textContent = String(Math.ceil(remaining / 1000));
    dialEl.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - remaining / totalMs));

    if (remaining > 0) return;
    clearInterval(timer);
    countEl.textContent = '0';
    if (target) {
      goBtn.disabled = false;
      goBtn.focus();
    }
  };

  tick();
  const timer = setInterval(tick, 100);
}

async function init() {
  const target = requestedUrl();
  const { delaySeconds, passMinutes } = await getPaceConfig();

  if (target) {
    hostEl.textContent = hostOf(target);
    goBtn.textContent = `Continue anyway · ${passMinutes} min`;
  } else {
    goBtn.remove();
    subEl.textContent = "Nothing to continue to — this screen was opened directly.";
  }

  backBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'focuslock:paceBack', url: target }).catch(() => {});
    leave();
  });

  goBtn.addEventListener('click', async () => {
    goBtn.disabled = true;
    goBtn.textContent = 'One moment…';
    try {
      // Waiting matters: the pass has to be in force before we navigate, or
      // the blocking rules bounce us straight back to this screen.
      await chrome.runtime.sendMessage({ type: 'focuslock:pacePass', url: target });
    } catch (err) {
      // Service worker asleep or restarting — go anyway; the navigation
      // check will simply pace this site again.
    }
    location.replace(target);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') backBtn.click();
  });

  startCountdown(delaySeconds, target);
  showTally();
}

init();

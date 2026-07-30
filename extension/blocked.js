// Shows how much of the session is left, so the block page answers the
// question you actually have when you hit it: "how long until I'm out?"
const STATUS_URL = 'http://127.0.0.1:38219/status?client=extension';

const card = document.getElementById('card');
const countEl = document.getElementById('count');
const labelEl = document.getElementById('count-label');
const subEl = document.getElementById('sub');

function format(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

async function load() {
  let status;
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    status = await res.json();
  } catch (err) {
    return; // app not reachable; the page still reads fine without a timer
  }

  if (!status.active || !status.endTime) return;

  subEl.textContent = status.hard
    ? 'Hard mode is on — this one runs to the end.'
    : 'FocusLock is protecting your session.';

  card.classList.remove('hidden');

  const tick = () => {
    const remaining = status.endTime - Date.now();
    countEl.textContent = format(remaining);
    if (remaining <= 0) {
      labelEl.textContent = 'session complete — reload to continue';
      clearInterval(timer);
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
}

load();

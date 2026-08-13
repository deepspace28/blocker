const STATUS_URL = 'http://127.0.0.1:38219/status?client=extension';
const content = document.getElementById('content');

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function renderDisconnected() {
  content.innerHTML = `
    <div class="state off">Not connected</div>
    <div class="err">The FocusLock desktop app isn't running, so nothing is being blocked. Start it and this will connect automatically.</div>
  `;
}

function renderStatus(status) {
  if (!status.active) {
    content.innerHTML = `
      <div class="state off">No session</div>
      <div class="detail">Connected to the FocusLock app. Start a session there to begin blocking.</div>
    `;
    return;
  }

  const modeLabel = status.mode === 'allow'
    ? 'Lock the Internet'
    : 'Blocking';
  const count = (status.domains || []).length;
  const listLabel = status.mode === 'allow'
    ? `${count} site${count === 1 ? '' : 's'} allowed`
    : `${count} site${count === 1 ? '' : 's'} blocked`;

  content.innerHTML = `
    <div class="state on">${modeLabel}</div>
    <div class="countdown" id="countdown">${formatRemaining(status.endTime - Date.now())}</div>
    <div class="detail">${listLabel}${status.hard ? ' · hard mode' : ''}</div>
    <div class="row"><span>Enforced in this browser</span><span>✓</span></div>
  `;

  const el = document.getElementById('countdown');
  setInterval(() => {
    el.textContent = formatRemaining(status.endTime - Date.now());
  }, 1000);
}

async function load() {
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    renderStatus(await res.json());
  } catch (err) {
    renderDisconnected();
  }
}

load();

let state = null;
let countdownTimer = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function switchTab(name) {
  $$('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${name}`));
}

$$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
$$('[data-goto]').forEach((el) => el.addEventListener('click', (e) => {
  e.preventDefault();
  switchTab(el.dataset.goto);
}));

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function renderHome() {
  const idle = $('#idle-view');
  const active = $('#active-view');
  const session = state.activeSession;

  if (!session) {
    idle.classList.remove('hidden');
    active.classList.add('hidden');
    if (countdownTimer) clearInterval(countdownTimer);
    return;
  }

  idle.classList.add('hidden');
  active.classList.remove('hidden');

  const meta = $('#session-meta');
  meta.textContent = `${session.domains.length} sites blocked · ${session.source === 'schedule' ? 'scheduled' : 'manual'} session${session.hard ? ' · hard mode' : ''}`;

  const stopBtn = $('#stop-session-btn');
  const hardHint = $('#hard-mode-hint');

  const updateCountdown = () => {
    const remaining = session.endTime - Date.now();
    $('#countdown').textContent = formatDuration(remaining);
    const locked = session.hard && remaining > 0;
    stopBtn.disabled = locked;
    hardHint.textContent = locked
      ? "Hard mode is on — this can't be stopped early, even by restarting the app."
      : '';
  };

  updateCountdown();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(updateCountdown, 1000);
}

function renderBlocklist() {
  const ul = $('#blocklist-ul');
  ul.innerHTML = '';
  for (const domain of state.blocklist) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = domain;
    const btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.textContent = '✕';
    btn.addEventListener('click', async () => {
      state.blocklist = await window.focuslock.removeBlocklistDomain(domain);
      renderBlocklist();
    });
    li.append(span, btn);
    ul.appendChild(li);
  }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function renderSchedules() {
  const ul = $('#schedules-ul');
  ul.innerHTML = '';
  for (const sched of state.schedules) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const days = sched.days.slice().sort().map((d) => DAY_NAMES[d]).join(', ');
    info.innerHTML = `<strong>${sched.name}</strong><br><span style="color:var(--text-dim)">${days} · ${sched.start}–${sched.end}${sched.hard ? ' · <span class="badge hard">hard</span>' : ''}</span>`;

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '8px';
    controls.style.alignItems = 'center';

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = sched.enabled;
    toggle.title = 'Enabled';
    toggle.addEventListener('change', async () => {
      state.schedules = await window.focuslock.updateSchedule(sched.id, { enabled: toggle.checked });
      renderSchedules();
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', async () => {
      state.schedules = await window.focuslock.removeSchedule(sched.id);
      renderSchedules();
    });

    controls.append(toggle, removeBtn);
    li.append(info, controls);
    ul.appendChild(li);
  }
}

function renderStats() {
  const history = state.history;
  const completed = history.filter((h) => !h.endedEarly);
  const totalMs = history.reduce((sum, h) => sum + (h.endTime - h.startTime), 0);
  const totalHours = (totalMs / 3600000).toFixed(1);

  let streak = 0;
  const byDay = new Map();
  for (const h of completed) {
    const day = new Date(h.startTime).toDateString();
    byDay.set(day, true);
  }
  for (let i = 0; ; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    if (byDay.has(d.toDateString())) streak++;
    else break;
  }

  const grid = $('#stats-grid');
  grid.innerHTML = '';
  const cards = [
    [history.length, 'Sessions'],
    [completed.length, 'Completed fully'],
    [`${totalHours}h`, 'Total blocked time'],
    [streak, 'Day streak'],
  ];
  for (const [value, label] of cards) {
    const div = document.createElement('div');
    div.className = 'stat-card';
    div.innerHTML = `<div class="stat-value">${value}</div><div class="stat-label">${label}</div>`;
    grid.appendChild(div);
  }

  const ul = $('#history-ul');
  ul.innerHTML = '';
  for (const h of history.slice(0, 30)) {
    const li = document.createElement('li');
    const start = new Date(h.startTime);
    const durationMin = Math.round((h.endTime - h.startTime) / 60000);
    li.innerHTML = `<span>${start.toLocaleString()} · ${durationMin}min</span>` +
      `<span>${h.hard ? '<span class="badge hard">hard</span>' : ''} ${h.endedEarly ? '<span class="badge early">stopped early</span>' : '<span class="badge">completed</span>'}</span>`;
    ul.appendChild(li);
  }
}

function renderAll() {
  renderHome();
  renderBlocklist();
  renderSchedules();
  renderStats();
}

// --- actions ---

$('#start-session-btn').addEventListener('click', async () => {
  const duration = Number($('#duration-input').value) || 25;
  const hard = $('#hard-mode-input').checked;
  const btn = $('#start-session-btn');
  btn.disabled = true;
  try {
    await window.focuslock.startSession({ durationMinutes: duration, hard });
  } catch (err) {
    alert(err.message || 'Could not start session (admin permission may have been denied).');
  } finally {
    btn.disabled = false;
  }
});

$('#stop-session-btn').addEventListener('click', async () => {
  const result = await window.focuslock.stopSession();
  if (!result.stopped && result.reason === 'hard-mode-locked') {
    alert("Hard mode is active — you can't stop this session early.");
  }
});

$('#add-domain-btn').addEventListener('click', async () => {
  const input = $('#domain-input');
  const value = input.value.trim();
  if (!value) return;
  state.blocklist = await window.focuslock.addBlocklistDomain(value);
  input.value = '';
  renderBlocklist();
});
$('#domain-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#add-domain-btn').click();
});

$('#add-schedule-btn').addEventListener('click', async () => {
  const name = $('#sched-name').value.trim() || 'Untitled schedule';
  const days = $$('#days-row input[type="checkbox"]:checked').map((el) => Number(el.value));
  const start = $('#sched-start').value;
  const end = $('#sched-end').value;
  const hard = $('#sched-hard').checked;

  if (!days.length) {
    alert('Pick at least one day.');
    return;
  }

  state.schedules = await window.focuslock.addSchedule({ name, days, start, end, hard });
  $('#sched-name').value = '';
  $$('#days-row input[type="checkbox"]').forEach((el) => (el.checked = false));
  $('#sched-hard').checked = false;
  renderSchedules();
});

// --- init ---

async function init() {
  state = await window.focuslock.getState();
  renderAll();
  window.focuslock.onStateUpdate((newState) => {
    state = newState;
    renderAll();
  });
}

init();

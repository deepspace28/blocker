let state = null;
let countdownTimer = null;
let presetsCache = null;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const RING_CIRCUMFERENCE = 2 * Math.PI * 96;

// ---------- tabs ----------

function switchTab(name) {
  $$('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}
$$('.tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

// ---------- helpers ----------

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function selectedMode() {
  return $('input[name="session-mode"]:checked').value;
}

// ---------- connection status ----------

function renderConnection() {
  const pill = $('#conn-pill');
  const text = $('#conn-text');
  const banner = $('#ext-banner');
  const connected = !!state.extensionConnected;

  pill.classList.toggle('online', connected);
  pill.classList.toggle('offline', !connected);
  text.textContent = connected ? 'Extension connected' : 'Extension not detected';
  pill.title = connected
    ? 'The FocusLock browser extension is connected and enforcing sessions.'
    : "No browser extension is talking to FocusLock, so websites won't be blocked.";

  banner.classList.toggle('hidden', connected);
}

// ---------- focus tab ----------

function renderHome() {
  const idle = $('#idle-view');
  const active = $('#active-view');
  const session = state.activeSession;

  if (!session) {
    idle.classList.remove('hidden');
    active.classList.add('hidden');
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    return;
  }

  idle.classList.add('hidden');
  active.classList.remove('hidden');

  const count = session.domains.length;
  const modeText = session.mode === 'allow'
    ? `Only ${count} site${count === 1 ? '' : 's'} allowed`
    : `${count} site${count === 1 ? '' : 's'} blocked`;
  const appsText = session.apps && session.apps.length
    ? ` · ${session.apps.length} app${session.apps.length === 1 ? '' : 's'} blocked`
    : '';
  const srcText = session.source === 'schedule' ? ' · scheduled' : '';
  $('#session-meta').textContent = `${modeText}${appsText}${srcText}`;

  const stopBtn = $('#stop-session-btn');
  const hardHint = $('#hard-mode-hint');
  const ring = $('#ring-fill');
  ring.classList.toggle('hard', !!session.hard);
  ring.style.strokeDasharray = String(RING_CIRCUMFERENCE);

  const totalMs = session.endTime - session.startTime;

  const tick = () => {
    const remaining = session.endTime - Date.now();
    $('#countdown').textContent = formatDuration(remaining);

    const progress = totalMs > 0 ? Math.min(1, Math.max(0, remaining / totalMs)) : 0;
    ring.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - progress));

    const locked = session.hard && remaining > 0;
    stopBtn.disabled = locked;
    stopBtn.textContent = locked ? 'Locked until the timer ends' : 'Stop session';
    hardHint.textContent = locked
      ? "Hard mode is on — this can't be stopped early, even by quitting or restarting."
      : '';
    $('#ring-label').textContent = remaining <= 0 ? 'finishing up' : 'remaining';
  };

  tick();
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = setInterval(tick, 1000);
}

function updateModeHint() {
  const mode = selectedMode();
  $('#mode-hint').textContent = mode === 'allow'
    ? 'Everything except your allowlist gets blocked, plus any blocked apps are closed.'
    : 'Everything on your blocklist gets blocked, plus any blocked apps are closed.';
}
$$('input[name="session-mode"]').forEach((el) => el.addEventListener('change', updateModeHint));

// duration presets
$$('#duration-presets .chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    $$('#duration-presets .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    $('#duration-input').value = chip.dataset.min;
  });
});
$('#duration-input').addEventListener('input', () => {
  const val = $('#duration-input').value;
  $$('#duration-presets .chip').forEach((c) => c.classList.toggle('active', c.dataset.min === val));
});

// ---------- lists ----------

function renderList(ulSelector, items, emptyText, onRemove) {
  const ul = $(ulSelector);
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.display = 'block';
    li.textContent = emptyText;
    ul.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = item;
    const btn = document.createElement('button');
    btn.className = 'remove-btn';
    btn.textContent = '✕';
    btn.title = 'Remove';
    btn.addEventListener('click', () => onRemove(item));
    li.append(span, btn);
    ul.appendChild(li);
  }
}

function renderBlocklist() {
  renderList('#blocklist-ul', state.blocklist, 'No sites yet — add one or use a category above.', async (d) => {
    state.blocklist = await window.focuslock.removeBlocklistDomain(d);
    renderBlocklist();
  });
}

function renderAllowlist() {
  renderList('#allowlist-ul', state.allowlist, 'No sites yet. Lock the Internet would block everything.', async (d) => {
    state.allowlist = await window.focuslock.removeAllowlistDomain(d);
    renderAllowlist();
  });
}

function renderApps() {
  renderList('#apps-ul', state.appBlocklist, 'No apps yet.', async (a) => {
    state.appBlocklist = await window.focuslock.removeBlockedApp(a);
    renderApps();
  });
}

async function renderPresets() {
  if (!presetsCache) presetsCache = await window.focuslock.getPresets();
  const row = $('#preset-row');
  if (row.childElementCount) return; // static content; build once
  for (const category of Object.keys(presetsCache)) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = `+ ${category}`;
    btn.addEventListener('click', async () => {
      state.blocklist = await window.focuslock.applyPreset(category);
      renderBlocklist();
    });
    row.appendChild(btn);
  }
}

// ---------- schedules ----------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function renderSchedules() {
  const ul = $('#schedules-ul');
  ul.innerHTML = '';

  if (!state.schedules.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.display = 'block';
    li.textContent = 'No schedules yet.';
    ul.appendChild(li);
    return;
  }

  for (const sched of state.schedules) {
    const li = document.createElement('li');

    const info = document.createElement('div');
    const days = sched.days.slice().sort().map((d) => DAY_NAMES[d]).join(' ');
    const name = document.createElement('strong');
    name.textContent = sched.name;
    const detail = document.createElement('div');
    detail.style.color = 'var(--text-dim)';
    detail.style.fontSize = '11.5px';
    detail.style.marginTop = '3px';
    detail.textContent = `${days} · ${sched.start}–${sched.end} · ${sched.mode === 'allow' ? 'Lock the Internet' : 'Block'}${sched.hard ? ' · hard' : ''}`;
    info.append(name, detail);

    const controls = document.createElement('div');
    controls.style.display = 'flex';
    controls.style.gap = '10px';
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

// ---------- stats ----------

function renderStats() {
  const history = state.history;
  const completed = history.filter((h) => !h.endedEarly);
  const totalMs = history.reduce((sum, h) => sum + (h.endTime - h.startTime), 0);

  const daysWithSession = new Set(completed.map((h) => new Date(h.startTime).toDateString()));
  // Count consecutive days backwards. A missing session *today* doesn't
  // break the streak — the day isn't over yet — but any earlier gap does.
  let streak = 0;
  for (let i = 0; i < 3650; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    if (daysWithSession.has(d.toDateString())) streak++;
    else if (i > 0) break;
  }

  const grid = $('#stats-grid');
  grid.innerHTML = '';
  const cards = [
    [history.length, 'Sessions'],
    [completed.length, 'Finished fully'],
    [`${(totalMs / 3600000).toFixed(1)}h`, 'Time protected'],
    [streak, 'Day streak'],
  ];
  for (const [value, label] of cards) {
    const div = document.createElement('div');
    div.className = 'stat-card';
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = value;
    const l = document.createElement('div');
    l.className = 'stat-label';
    l.textContent = label;
    div.append(v, l);
    grid.appendChild(div);
  }

  const ul = $('#history-ul');
  ul.innerHTML = '';
  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.style.display = 'block';
    li.textContent = 'No sessions yet.';
    ul.appendChild(li);
    return;
  }
  for (const h of history.slice(0, 30)) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    const mins = Math.round((h.endTime - h.startTime) / 60000);
    left.textContent = `${new Date(h.startTime).toLocaleString()} · ${mins}min`;

    const right = document.createElement('span');
    right.style.display = 'flex';
    right.style.gap = '5px';
    if (h.hard) {
      const b = document.createElement('span');
      b.className = 'badge hard';
      b.textContent = 'hard';
      right.appendChild(b);
    }
    const status = document.createElement('span');
    status.className = h.endedEarly ? 'badge early' : 'badge done';
    status.textContent = h.endedEarly ? 'stopped early' : 'completed';
    right.appendChild(status);

    li.append(left, right);
    ul.appendChild(li);
  }
}

// ---------- render all ----------

function renderAll() {
  renderConnection();
  renderHome();
  renderBlocklist();
  renderAllowlist();
  renderApps();
  renderPresets();
  renderSchedules();
  renderStats();
}

// ---------- actions ----------

$('#start-session-btn').addEventListener('click', async () => {
  const btn = $('#start-session-btn');
  const durationMinutes = Number($('#duration-input').value) || 25;
  const mode = selectedMode();

  if (mode === 'allow' && !state.allowlist.length) {
    alert('Add at least one site to your allowlist first, or Lock the Internet would block everything.');
    switchTab('allowlist');
    return;
  }
  if (mode === 'block' && !state.blocklist.length) {
    alert('Your blocklist is empty — add some sites first.');
    switchTab('blocklist');
    return;
  }
  if (!state.extensionConnected &&
      !confirm("The browser extension isn't connected, so websites won't be blocked (blocked apps still will).\n\nStart the session anyway?")) {
    return;
  }

  btn.disabled = true;
  try {
    await window.focuslock.startSession({ durationMinutes, hard: $('#hard-mode-input').checked, mode });
  } catch (err) {
    alert(err.message || 'Could not start the session.');
  } finally {
    btn.disabled = false;
  }
});

$('#stop-session-btn').addEventListener('click', async () => {
  const result = await window.focuslock.stopSession();
  if (!result.stopped && result.reason === 'hard-mode-locked') {
    alert("Hard mode is active — this session can't be stopped early.");
  }
});

function wireAdd(inputSel, btnSel, addFn, rerender) {
  const input = $(inputSel);
  const submit = async () => {
    const value = input.value.trim();
    if (!value) return;
    await addFn(value);
    input.value = '';
    rerender();
  };
  $(btnSel).addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

wireAdd('#domain-input', '#add-domain-btn',
  async (v) => { state.blocklist = await window.focuslock.addBlocklistDomain(v); }, renderBlocklist);
wireAdd('#allow-input', '#add-allow-btn',
  async (v) => { state.allowlist = await window.focuslock.addAllowlistDomain(v); }, renderAllowlist);
wireAdd('#app-input', '#add-app-btn',
  async (v) => { state.appBlocklist = await window.focuslock.addBlockedApp(v); }, renderApps);

$('#add-schedule-btn').addEventListener('click', async () => {
  const days = $$('#days-row input[type="checkbox"]:checked').map((el) => Number(el.value));
  if (!days.length) {
    alert('Pick at least one day.');
    return;
  }
  state.schedules = await window.focuslock.addSchedule({
    name: $('#sched-name').value.trim() || 'Untitled schedule',
    days,
    start: $('#sched-start').value,
    end: $('#sched-end').value,
    hard: $('#sched-hard').checked,
    mode: $('input[name="sched-mode"]:checked').value,
  });
  $('#sched-name').value = '';
  $$('#days-row input[type="checkbox"]').forEach((el) => (el.checked = false));
  $('#sched-hard').checked = false;
  renderSchedules();
});

// ---------- init ----------

async function init() {
  state = await window.focuslock.getState();
  renderAll();
  updateModeHint();
  window.focuslock.onStateUpdate((newState) => {
    state = newState;
    renderAll();
  });
}

init();

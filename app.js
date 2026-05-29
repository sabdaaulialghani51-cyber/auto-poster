/* ─────────────────────────────────────────────────────
   Discord Autoposter — app.js
   Self-contained: no server, no dependencies.
   Uses Discord User Token (Self-bot) to POST messages
   directly to https://discord.com/api/v10/channels/:id/messages
   ───────────────────────────────────────────────────── */

const DISCORD_API = 'https://discord.com/api/v10';
const STORE_KEY   = 'dap_v2_data'; // localStorage key

// ── State ────────────────────────────────────────────
let state = {
  token: null,
  user: null,         // { id, username, discriminator, avatar }
  projects: [],       // [{ id, name, channelId, message, delay, running, sent, failed }]
  activeProjectId: null,
};

// Per-project timer handles (not persisted)
const timers = {};

// ── Persistence ──────────────────────────────────────
function saveState() {
  const data = {
    token: state.token,
    user: state.user,
    projects: state.projects.map(p => ({ ...p, running: false })), // never persist running=true
  };
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    state.token    = data.token    || null;
    state.user     = data.user     || null;
    state.projects = data.projects || [];
    return !!(state.token && state.user);
  } catch { return false; }
}

// ── Discord API ───────────────────────────────────────
async function discordFetch(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': state.token,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(DISCORD_API + path, opts);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function validateToken(token) {
  const tempToken = state.token;
  state.token = token;
  const { ok, json } = await discordFetch('/users/@me');
  if (!ok) { state.token = tempToken; return null; }
  return json; // user object
}

async function sendMessage(channelId, content) {
  return discordFetch(`/channels/${channelId}/messages`, 'POST', { content });
}

// ── Toast ─────────────────────────────────────────────
function toast(msg, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Logging ───────────────────────────────────────────
function getActiveProject() {
  return state.projects.find(p => p.id === state.activeProjectId);
}

function log(msg, type = 'info') {
  const body = document.getElementById('log-body');
  if (!body) return;
  const empty = body.querySelector('.log-empty');
  if (empty) empty.remove();

  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-time">[${time}]</span><span class="log-${type}">${escHtml(msg)}</span>`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── UI Helpers ────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(name + '-screen').classList.add('active');
}

function setUserChip(user) {
  const avatar = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${(parseInt(user.id) >> 22) % 6}.png`;
  $('user-avatar').src = avatar;
  const tag = user.discriminator && user.discriminator !== '0'
    ? `${user.username}#${user.discriminator}`
    : user.username;
  $('user-username').textContent = tag;
}

// ── Project List Render ───────────────────────────────
function renderProjectList() {
  const list = $('project-list');
  list.innerHTML = '';

  if (state.projects.length === 0) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:0.8rem;padding:8px;text-align:center">Belum ada project</div>';
    return;
  }

  state.projects.forEach(p => {
    const card = document.createElement('div');
    card.className = 'project-card' + (p.id === state.activeProjectId ? ' active' : '');
    card.dataset.id = p.id;

    const dot = document.createElement('div');
    dot.className = 'project-status-dot' + (p.running ? ' running' : '');

    const info = document.createElement('div');
    info.className = 'project-card-info';
    info.innerHTML = `
      <div class="project-card-name">${escHtml(p.name || 'Unnamed')}</div>
      <div class="project-card-sub">${p.channelId ? '#' + p.channelId : 'No channel set'}</div>
    `;

    card.appendChild(info);
    card.appendChild(dot);
    card.addEventListener('click', () => selectProject(p.id));
    list.appendChild(card);
  });
}

// ── Select / Activate Project ─────────────────────────
function selectProject(id) {
  state.activeProjectId = id;
  const p = getActiveProject();
  if (!p) return;

  renderProjectList(); // re-highlight active

  $('empty-project').style.display = 'none';
  $('project-editor').style.display = 'block';

  // Fill fields
  $('cfg-project-name').value = p.name    || '';
  $('cfg-channel-id').value   = p.channelId || '';
  $('cfg-message').value      = p.message  || '';
  $('cfg-delay').value        = p.delay != null ? p.delay : 5;

  $('editor-project-name').textContent = p.name || 'Unnamed';

  updateEditorStatus(p);
  updateStats(p);
}

function updateEditorStatus(p) {
  if (!p) return;
  const badge = $('editor-status-badge');
  const startBtn = $('start-stop-btn');
  const label = $('start-stop-label');
  const startIcon = $('start-icon');
  const stopIcon  = $('stop-icon');

  if (p.running) {
    badge.textContent   = '🟢 Running';
    badge.className     = 'editor-status-badge running';
    label.textContent   = 'Stop Autopost';
    startBtn.classList.add('running');
    startIcon.style.display = 'none';
    stopIcon.style.display  = '';
  } else {
    badge.textContent   = '⏹ Stopped';
    badge.className     = 'editor-status-badge stopped';
    label.textContent   = 'Mulai Autopost';
    startBtn.classList.remove('running');
    startIcon.style.display = '';
    stopIcon.style.display  = 'none';
  }
}

function updateStats(p) {
  if (!p) return;
  $('stat-sent').textContent    = p.sent    || 0;
  $('stat-failed').textContent  = p.failed  || 0;
  $('stat-countdown').textContent = '--:--';
}

// ── Add Project ───────────────────────────────────────
function addProject() {
  const id = 'proj_' + Date.now();
  const project = { id, name: 'Project Baru', channelId: '', message: '', delay: 5, running: false, sent: 0, failed: 0 };
  state.projects.push(project);
  saveState();
  renderProjectList();
  selectProject(id);
}

// ── Delete Project ────────────────────────────────────
function deleteProject(id) {
  stopProject(id);
  state.projects = state.projects.filter(p => p.id !== id);
  if (state.activeProjectId === id) {
    state.activeProjectId = null;
    $('empty-project').style.display = '';
    $('project-editor').style.display = 'none';
  }
  saveState();
  renderProjectList();
}

// ── Save Config ───────────────────────────────────────
function saveConfig() {
  const p = getActiveProject();
  if (!p) return;

  const name    = $('cfg-project-name').value.trim();
  const channel = $('cfg-channel-id').value.trim();
  const message = $('cfg-message').value;
  const delay   = parseFloat($('cfg-delay').value) || 0;

  if (!name)    { toast('Nama project tidak boleh kosong', 'error'); return; }
  if (!channel) { toast('Channel ID tidak boleh kosong', 'error'); return; }
  if (!message.trim()) { toast('Teks pesan tidak boleh kosong', 'error'); return; }

  p.name      = name;
  p.channelId = channel;
  p.message   = message;
  p.delay     = delay;

  saveState();
  renderProjectList();
  $('editor-project-name').textContent = name;
  toast('✅ Konfigurasi disimpan!', 'success');
}

// ── Autopost Logic ────────────────────────────────────
function startProject(id) {
  const p = state.projects.find(x => x.id === id);
  if (!p || p.running) return;
  if (!p.channelId || !p.message) {
    toast('Simpan konfigurasi channel & pesan dulu!', 'error');
    return;
  }

  p.running = true;
  p.sent    = p.sent    || 0;
  p.failed  = p.failed  || 0;
  renderProjectList();
  updateEditorStatus(p);
  log(`▶ Memulai autopost ke channel ${p.channelId} (delay: ${p.delay === 0 ? 'Auto' : p.delay + ' menit'})`, 'info');

  scheduleNext(id);
}

function stopProject(id) {
  const p = state.projects.find(x => x.id === id);
  if (!p) return;

  if (timers[id]) { clearTimeout(timers[id]); delete timers[id]; }
  p.running = false;
  saveState();
  renderProjectList();

  if (p.id === state.activeProjectId) {
    updateEditorStatus(p);
    $('stat-countdown').textContent = '--:--';
    log('⏹ Autopost dihentikan.', 'warn');
  }
}

function scheduleNext(id) {
  const p = state.projects.find(x => x.id === id);
  if (!p || !p.running) return;

  const delayMs = p.delay === 0 ? 1500 : p.delay * 60 * 1000;

  // Send immediately first
  doSend(id);

  // Then schedule recurring
  function loop() {
    const proj = state.projects.find(x => x.id === id);
    if (!proj || !proj.running) return;
    doSend(id);
    startCountdown(id, delayMs);
    timers[id] = setTimeout(loop, delayMs);
  }

  startCountdown(id, delayMs);
  timers[id] = setTimeout(loop, delayMs);
}

async function doSend(id) {
  const p = state.projects.find(x => x.id === id);
  if (!p) return;

  const { ok, status, json } = await sendMessage(p.channelId, p.message);

  if (ok) {
    p.sent = (p.sent || 0) + 1;
    if (p.id === state.activeProjectId) {
      $('stat-sent').textContent = p.sent;
      log(`✅ Pesan terkirim! (total: ${p.sent})`, 'success');
    }
  } else {
    p.failed = (p.failed || 0) + 1;
    const reason = json.message || `HTTP ${status}`;
    if (p.id === state.activeProjectId) {
      $('stat-failed').textContent = p.failed;
      log(`❌ Gagal kirim: ${reason}`, 'error');
    }

    // Stop if forbidden/unauthorized
    if (status === 401 || status === 403) {
      log('🔒 Token tidak valid atau akses ditolak. Autopost dihentikan.', 'error');
      stopProject(id);
      return;
    }
  }
}

// ── Countdown Display ─────────────────────────────────
let countdownInterval = {};

function startCountdown(id, totalMs) {
  if (id !== state.activeProjectId) return;
  if (countdownInterval[id]) clearInterval(countdownInterval[id]);

  let remaining = Math.ceil(totalMs / 1000);
  const tick = () => {
    if (remaining <= 0) { clearInterval(countdownInterval[id]); return; }
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    const el = $('stat-countdown');
    if (el) el.textContent = `${m}:${s}`;
    remaining--;
  };
  tick();
  countdownInterval[id] = setInterval(tick, 1000);
}

// ── Toggle Start/Stop ─────────────────────────────────
function toggleStartStop() {
  const p = getActiveProject();
  if (!p) return;

  // Save current values first
  const name    = $('cfg-project-name').value.trim();
  const channel = $('cfg-channel-id').value.trim();
  const message = $('cfg-message').value;
  const delay   = parseFloat($('cfg-delay').value) || 0;

  if (!p.running) {
    if (!name || !channel || !message.trim()) {
      toast('Lengkapi Nama Project, Channel ID, dan Teks Pesan dulu!', 'error');
      return;
    }
    p.name      = name;
    p.channelId = channel;
    p.message   = message;
    p.delay     = delay;
    saveState();
    renderProjectList();
    $('editor-project-name').textContent = name;
    startProject(p.id);
  } else {
    stopProject(p.id);
  }
}

// ── Emoji Insert ──────────────────────────────────────
function insertEmoji(emoji) {
  const ta = $('cfg-message');
  const start = ta.selectionStart;
  const end   = ta.selectionEnd;
  ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
  ta.selectionStart = ta.selectionEnd = start + emoji.length;
  ta.focus();
}

// ── Login Flow ────────────────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('token-input').value.trim();
  if (!token) return;

  const btn     = $('login-btn');
  const btnText = $('login-btn-text');
  const spinner = $('login-spinner');

  btn.disabled      = true;
  btnText.style.display = 'none';
  spinner.style.display = '';

  const user = await validateToken(token);

  btn.disabled      = false;
  btnText.style.display = '';
  spinner.style.display = 'none';

  if (!user) {
    toast('❌ Token tidak valid! Pastikan token Discord kamu benar.', 'error');
    return;
  }

  state.token = token;
  state.user  = user;
  saveState();
  mountApp();
});

// Toggle token visibility
$('toggle-token-vis').addEventListener('click', () => {
  const input   = $('token-input');
  const eye     = $('eye-icon');
  const eyeOff  = $('eye-off-icon');
  if (input.type === 'password') {
    input.type = 'text';
    eye.style.display = 'none';
    eyeOff.style.display = '';
  } else {
    input.type = 'password';
    eye.style.display = '';
    eyeOff.style.display = 'none';
  }
});

// ── App Mount ─────────────────────────────────────────
function mountApp() {
  setUserChip(state.user);
  renderProjectList();
  showScreen('app');

  // If there's only one project, auto-select it
  if (state.projects.length === 1) {
    selectProject(state.projects[0].id);
  }
}

// ── App Event Bindings ────────────────────────────────
$('add-project-btn').addEventListener('click', addProject);
$('save-config-btn').addEventListener('click', saveConfig);
$('start-stop-btn').addEventListener('click', toggleStartStop);
$('delete-project-btn').addEventListener('click', () => {
  const p = getActiveProject();
  if (!p) return;
  if (confirm(`Hapus project "${p.name}"?`)) deleteProject(p.id);
});
$('clear-log-btn').addEventListener('click', () => {
  $('log-body').innerHTML = '<div class="log-empty">Log dibersihkan.</div>';
});
$('logout-btn').addEventListener('click', () => {
  // Stop all running projects
  state.projects.forEach(p => stopProject(p.id));
  state.token    = null;
  state.user     = null;
  saveState();
  $('token-input').value = '';
  showScreen('login');
  toast('Logout berhasil.', 'info');
});

// ── Boot ──────────────────────────────────────────────
(function init() {
  const loggedIn = loadState();
  if (loggedIn) {
    mountApp();
  } else {
    showScreen('login');
  }
})();

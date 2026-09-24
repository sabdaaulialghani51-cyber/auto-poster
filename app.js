/* ─────────────────────────────────────────────────────
   Discord Autoposter — app.js
   Frontend ONLY controls the server. All message sending
   happens server-side (server.js), so autopost keeps
   running 24/7 even when this website is closed.
   ───────────────────────────────────────────────────── */

const STORE_KEY = 'dap_v2_session'; // localStorage key (only token + user cached)

// ── State ────────────────────────────────────────────
let state = {
  token: null,
  user: null,         // { id, username, discriminator, avatar }
  projects: [],       // fetched from server
  activeProjectId: null,
};

// Per-project stats polling handles (not persisted)
const pollers = {};

// ── Session persistence (only token + user, projects live on server) ──
function saveSession() {
  localStorage.setItem(STORE_KEY, JSON.stringify({ token: state.token, user: state.user }));
}

function loadSession() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    state.token = data.token || null;
    state.user  = data.user  || null;
    return !!(state.token && state.user);
  } catch { return false; }
}

function clearSession() {
  localStorage.removeItem(STORE_KEY);
}

// ── Server API ────────────────────────────────────────
async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

async function validateToken(token) {
  const { ok, json } = await api('/api/auth/validate', 'POST', { token });
  if (!ok) return null;
  return json.user; // user object
}

async function fetchProjects() {
  if (!state.user) return;
  const { ok, json } = await api(`/api/projects?userId=${encodeURIComponent(state.user.id)}`);
  if (ok && Array.isArray(json)) state.projects = json;
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
  // Stop polling any previously active project
  stopPolling(state.activeProjectId);

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

  // Poll live stats from the server for this project
  startPolling(id);
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

// ── Live stats polling (server is the source of truth) ──
function startPolling(id) {
  stopPolling(id);
  const tick = async () => {
    if (id !== state.activeProjectId) return;
    const { ok, json } = await api(`/api/projects/${id}/stats`);
    if (!ok) return;

    const p = state.projects.find(x => x.id === id);
    if (p) {
      const wasRunning = p.running;
      p.running = json.running;
      p.sent    = json.sent;
      p.failed  = json.failed;
      p.lastError = json.lastError;

      $('stat-sent').textContent   = json.sent   || 0;
      $('stat-failed').textContent = json.failed || 0;

      if (json.running && json.nextSendIn != null) {
        const m = String(Math.floor(json.nextSendIn / 60)).padStart(2, '0');
        const s = String(json.nextSendIn % 60).padStart(2, '0');
        $('stat-countdown').textContent = `${m}:${s}`;
      } else {
        $('stat-countdown').textContent = '--:--';
      }

      if (wasRunning !== p.running) {
        updateEditorStatus(p);
        renderProjectList();
        if (!p.running && wasRunning) {
          log(json.lastError ? `⏹ Berhenti: ${json.lastError}` : '⏹ Autopost berhenti.', 'warn');
        }
      }
    }
  };
  tick();
  pollers[id] = setInterval(tick, 2000);
}

function stopPolling(id) {
  if (id && pollers[id]) { clearInterval(pollers[id]); delete pollers[id]; }
}

// ── Add Project ───────────────────────────────────────
async function addProject() {
  const { ok, json } = await api('/api/projects', 'POST', {
    userId: state.user.id,
    token: state.token,
    name: 'Project Baru',
    channelId: '',
    message: '',
    delay: 5,
  });
  if (!ok) { toast('Gagal membuat project: ' + (json.error || ''), 'error'); return; }

  await fetchProjects();
  renderProjectList();
  selectProject(json.id);
}

// ── Delete Project ────────────────────────────────────
async function deleteProject(id) {
  stopPolling(id);
  const { ok } = await api(`/api/projects/${id}`, 'DELETE');
  if (!ok) { toast('Gagal menghapus project', 'error'); return; }

  await fetchProjects();
  if (state.activeProjectId === id) {
    state.activeProjectId = null;
    $('empty-project').style.display = '';
    $('project-editor').style.display = 'none';
  }
  renderProjectList();
}

// ── Save Config ───────────────────────────────────────
async function saveConfig() {
  const p = getActiveProject();
  if (!p) return;

  const name    = $('cfg-project-name').value.trim();
  const channel = $('cfg-channel-id').value.trim();
  const message = $('cfg-message').value;
  const delay   = parseFloat($('cfg-delay').value) || 0;

  if (!name)    { toast('Nama project tidak boleh kosong', 'error'); return; }
  if (!channel) { toast('Channel ID tidak boleh kosong', 'error'); return; }
  if (!message.trim()) { toast('Teks pesan tidak boleh kosong', 'error'); return; }

  const { ok, json } = await api(`/api/projects/${p.id}`, 'PUT', {
    name, channelId: channel, message, delay, token: state.token,
  });
  if (!ok) { toast('Gagal menyimpan: ' + (json.error || ''), 'error'); return; }

  await fetchProjects();
  renderProjectList();
  $('editor-project-name').textContent = name;
  toast('✅ Konfigurasi disimpan!', 'success');
}

// ── Start / Stop Autopost (server-side) ───────────────
async function startProject(id) {
  const { ok, json } = await api(`/api/projects/${id}/start`, 'POST');
  if (!ok) { toast('Gagal memulai: ' + (json.error || ''), 'error'); return; }

  const p = state.projects.find(x => x.id === id);
  if (p) { p.running = true; updateEditorStatus(p); renderProjectList(); }
  log('▶ Autopost dimulai di server. Website boleh ditutup, pengiriman tetap jalan.', 'success');
  startPolling(id);
}

async function stopProject(id) {
  const { ok } = await api(`/api/projects/${id}/stop`, 'POST');
  if (!ok) { toast('Gagal menghentikan', 'error'); return; }

  const p = state.projects.find(x => x.id === id);
  if (p) { p.running = false; if (p.id === state.activeProjectId) updateEditorStatus(p); }
  renderProjectList();
  if (id === state.activeProjectId) {
    $('stat-countdown').textContent = '--:--';
    log('⏹ Autopost dihentikan.', 'warn');
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

// ── Toggle Start/Stop ─────────────────────────────────
async function toggleStartStop() {
  const p = getActiveProject();
  if (!p) return;

  const name    = $('cfg-project-name').value.trim();
  const channel = $('cfg-channel-id').value.trim();
  const message = $('cfg-message').value;
  const delay   = parseFloat($('cfg-delay').value) || 0;

  if (!p.running) {
    if (!name || !channel || !message.trim()) {
      toast('Lengkapi Nama Project, Channel ID, dan Teks Pesan dulu!', 'error');
      return;
    }
    // Save latest config to server first, then start
    const save = await api(`/api/projects/${p.id}`, 'PUT', {
      name, channelId: channel, message, delay, token: state.token,
    });
    if (!save.ok) { toast('Gagal menyimpan konfigurasi', 'error'); return; }

    await fetchProjects();
    renderProjectList();
    $('editor-project-name').textContent = name;
    await startProject(p.id);
  } else {
    await stopProject(p.id);
  }
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
  saveSession();
  await mountApp();
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
async function mountApp() {
  setUserChip(state.user);
  await fetchProjects();
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
  // Note: does NOT stop server-side jobs — they keep running 24/7.
  Object.keys(pollers).forEach(stopPolling);
  state.token   = null;
  state.user    = null;
  state.projects = [];
  state.activeProjectId = null;
  clearSession();
  $('token-input').value = '';
  showScreen('login');
  toast('Logout berhasil. Autopost yang aktif tetap berjalan di server.', 'info');
});

// ── Boot ──────────────────────────────────────────────
(async function init() {
  const loggedIn = loadSession();
  if (loggedIn) {
    await mountApp();
  } else {
    showScreen('login');
  }
})();

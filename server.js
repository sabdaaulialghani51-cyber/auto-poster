/**
 * Discord Autoposter — server.js
 * Runs 24/7 on the cloud. Posts messages to Discord even when browser is closed.
 * Deploy to Railway / Render / VPS for always-on posting.
 */

const express  = require('express');
const fetch    = require('node-fetch');
const fs       = require('fs');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const DISCORD_API = 'https://discord.com/api/v10';

// ── Middleware ─────────────────────────────────────────
app.use(express.json());
// Static files (index.html, style.css, app.js) live in the project root
app.use(express.static(__dirname));

// Explicitly serve the frontend at "/"
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Data Store (JSON file) ────────────────────────────
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return { accounts: [], projects: [] };
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch { return { accounts: [], projects: [] }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── In-memory autopost state ───────────────────────────
// { [projectId]: { timer: setTimeout handle, running: bool, nextSendAt: timestamp } }
const runningJobs = {};

// ── Discord API Helper ─────────────────────────────────
async function discordFetch(token, path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(DISCORD_API + path, opts);
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: { message: err.message } };
  }
}

// ── Autopost Engine ────────────────────────────────────
function startJob(project) {
  if (runningJobs[project.id]?.running) return;

  console.log(`[START] Project "${project.name}" → channel ${project.channelId}`);

  const delayMs = project.delay === 0 ? 3000 : project.delay * 60 * 1000;

  const data = loadData();
  const proj = data.projects.find(p => p.id === project.id);
  if (proj) { proj.running = true; saveData(data); }

  runningJobs[project.id] = { running: true, nextSendAt: null };

  const doSend = async () => {
    if (!runningJobs[project.id]?.running) return;

    const d = loadData();
    const p = d.projects.find(x => x.id === project.id);
    if (!p || !p.running) { stopJob(project.id); return; }

    const { ok, status, json } = await discordFetch(
      p.token, `/channels/${p.channelId}/messages`, 'POST', { content: p.message }
    );

    const timestamp = new Date().toISOString();
    if (ok) {
      p.sent = (p.sent || 0) + 1;
      p.lastSent = timestamp;
      console.log(`[OK] "${p.name}" → sent (total: ${p.sent})`);
    } else {
      p.failed = (p.failed || 0) + 1;
      p.lastError = json.message || `HTTP ${status}`;
      console.log(`[ERR] "${p.name}" → ${p.lastError}`);

      if (status === 401 || status === 403) {
        console.log(`[STOP] Token invalid for "${p.name}"`);
        p.running = false;
        saveData(d);
        stopJob(project.id);
        return;
      }
    }
    saveData(d);

    if (runningJobs[project.id]?.running) {
      const nextAt = Date.now() + delayMs;
      runningJobs[project.id].nextSendAt = nextAt;
      runningJobs[project.id].timer = setTimeout(doSend, delayMs);
    }
  };

  // Send first immediately, then loop
  doSend();
}

function stopJob(projectId) {
  if (runningJobs[projectId]) {
    if (runningJobs[projectId].timer) clearTimeout(runningJobs[projectId].timer);
    runningJobs[projectId].running = false;
    delete runningJobs[projectId];
  }
  const data = loadData();
  const p = data.projects.find(x => x.id === projectId);
  if (p) { p.running = false; saveData(data); }
  console.log(`[STOP] Project ${projectId}`);
}

// Resume running projects on server start
function resumeJobs() {
  const data = loadData();
  data.projects.forEach(p => {
    if (p.running && p.token && p.channelId && p.message) {
      console.log(`[RESUME] Resuming project "${p.name}"`);
      startJob(p);
    }
  });
}

// ── REST API ────────────────────────────────────────────

// Validate Discord token
app.post('/api/auth/validate', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const { ok, json } = await discordFetch(token, '/users/@me');
  if (!ok) return res.status(401).json({ error: 'Invalid token', detail: json.message });

  // Store account if not exists
  const data = loadData();
  let account = data.accounts.find(a => a.id === json.id);
  if (!account) {
    account = { id: json.id, username: json.username, discriminator: json.discriminator, avatar: json.avatar, token };
    data.accounts.push(account);
  } else {
    account.token = token;
    account.username = json.username;
    account.avatar = json.avatar;
  }
  saveData(data);
  res.json({ user: { id: json.id, username: json.username, discriminator: json.discriminator, avatar: json.avatar } });
});

// Get all projects for a user
app.get('/api/projects', (req, res) => {
  const { userId } = req.query;
  const data = loadData();
  const projects = data.projects
    .filter(p => p.userId === userId)
    .map(p => ({ ...p, token: undefined })); // never expose token to frontend
  res.json(projects);
});

// Create project
app.post('/api/projects', (req, res) => {
  const { userId, token, name, channelId, message, delay } = req.body;
  if (!userId || !token) return res.status(400).json({ error: 'userId and token required' });

  const data = loadData();
  const project = {
    id: uuidv4(),
    userId,
    token,
    name: name || 'Project Baru',
    channelId: channelId || '',
    message: message || '',
    delay: delay ?? 5,
    running: false,
    sent: 0,
    failed: 0,
    lastSent: null,
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  data.projects.push(project);
  saveData(data);

  const { token: _, ...safe } = project;
  res.json(safe);
});

// Update project
app.put('/api/projects/:id', (req, res) => {
  const data = loadData();
  const idx = data.projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const { name, channelId, message, delay, token } = req.body;
  const p = data.projects[idx];
  if (name      !== undefined) p.name      = name;
  if (channelId !== undefined) p.channelId = channelId;
  if (message   !== undefined) p.message   = message;
  if (delay     !== undefined) p.delay     = delay;
  if (token     !== undefined) p.token     = token;

  saveData(data);
  const { token: _, ...safe } = p;
  res.json(safe);
});

// Delete project
app.delete('/api/projects/:id', (req, res) => {
  stopJob(req.params.id);
  const data = loadData();
  data.projects = data.projects.filter(p => p.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

// Start autopost
app.post('/api/projects/:id/start', (req, res) => {
  const data = loadData();
  const p = data.projects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (!p.channelId || !p.message) return res.status(400).json({ error: 'channelId and message required' });
  if (!p.token) return res.status(400).json({ error: 'No token for this project' });

  startJob(p);
  res.json({ ok: true, message: 'Autopost started' });
});

// Stop autopost
app.post('/api/projects/:id/stop', (req, res) => {
  stopJob(req.params.id);
  res.json({ ok: true, message: 'Autopost stopped' });
});

// Get project stats (live)
app.get('/api/projects/:id/stats', (req, res) => {
  const data = loadData();
  const p = data.projects.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });

  const job = runningJobs[p.id];
  const running = !!(p.running || job?.running);
  let nextSendIn = null;
  if (running && job?.nextSendAt) {
    nextSendIn = Math.max(0, Math.round((job.nextSendAt - Date.now()) / 1000));
  }

  res.json({
    id: p.id,
    running,
    sent: p.sent || 0,
    failed: p.failed || 0,
    lastSent: p.lastSent,
    lastError: p.lastError,
    nextSendIn, // seconds until next message
  });
});

// Health check
app.get('/api/health', (req, res) => {
  const data = loadData();
  const activeJobs = Object.keys(runningJobs).length;
  res.json({ status: 'ok', activeJobs, projects: data.projects.length, uptime: process.uptime() });
});

// ── Start Server ───────────────────────────────────────
// On Vercel (serverless) we export the app instead of calling listen().
if (process.env.VERCEL) {
  module.exports = app;
} else {
  app.listen(PORT, () => {
    console.log(`✅ Discord Autoposter running on port ${PORT}`);
    console.log(`🌐 Open: http://localhost:${PORT}`);
    resumeJobs();
  });
}

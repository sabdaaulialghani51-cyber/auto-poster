/**
 * Discord Autoposter — server.js
 * Runs 24/7 on the cloud. Posts messages to Discord even when browser is closed.
 * Deploy to Railway / Render / VPS for always-on posting.
 *
 * Data is persisted in Postgres (Neon) via db.js — survives restarts/redeploys.
 */

const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');
const db       = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;
const DISCORD_API = 'https://discord.com/api/v10';

// ── Middleware ─────────────────────────────────────────
app.use(express.json());
// Static files (index.html, style.css, app.js) live in the project root
app.use(express.static(__dirname));

// Explicitly serve the frontend at "/"
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

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

  runningJobs[project.id] = { running: true, nextSendAt: null };
  db.setProjectRunning(project.id, true).catch(err => console.error('[DB ERR]', err.message));

  const doSend = async () => {
    if (!runningJobs[project.id]?.running) return;

    const p = await db.getProject(project.id);
    if (!p || !p.running) { stopJob(project.id); return; }

    const { ok, status, json } = await discordFetch(
      p.token, `/channels/${p.channelId}/messages`, 'POST', { content: p.message }
    );

    const timestamp = new Date().toISOString();
    if (ok) {
      await db.recordSuccess(p.id, timestamp);
      console.log(`[OK] "${p.name}" → sent`);
    } else {
      const errorMessage = json.message || `HTTP ${status}`;
      const shouldStop = status === 401 || status === 403;
      await db.recordFailure(p.id, errorMessage, shouldStop);
      console.log(`[ERR] "${p.name}" → ${errorMessage}`);

      if (shouldStop) {
        console.log(`[STOP] Token invalid for "${p.name}"`);
        stopJob(project.id);
        return;
      }
    }

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
  db.setProjectRunning(projectId, false).catch(err => console.error('[DB ERR]', err.message));
  console.log(`[STOP] Project ${projectId}`);
}

// Resume running projects on server start
async function resumeJobs() {
  try {
    const projects = await db.getAllProjects();
    projects.forEach(p => {
      if (p.running && p.token && p.channelId && p.message) {
        console.log(`[RESUME] Resuming project "${p.name}"`);
        startJob(p);
      }
    });
  } catch (err) {
    console.error('[RESUME ERR]', err.message);
  }
}

// ── REST API ────────────────────────────────────────────

// Validate Discord token
app.post('/api/auth/validate', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const { ok, json } = await discordFetch(token, '/users/@me');
  if (!ok) return res.status(401).json({ error: 'Invalid token', detail: json.message });

  try {
    await db.upsertAccount({
      id: json.id,
      username: json.username,
      discriminator: json.discriminator,
      avatar: json.avatar,
      token,
    });
    res.json({ user: { id: json.id, username: json.username, discriminator: json.discriminator, avatar: json.avatar } });
  } catch (err) {
    console.error('[DB ERR]', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Get all projects for a user
app.get('/api/projects', async (req, res) => {
  const { userId } = req.query;
  try {
    const projects = await db.getProjectsByUser(userId);
    res.json(projects.map(p => ({ ...p, token: undefined }))); // never expose token to frontend
  } catch (err) {
    console.error('[DB ERR]', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Create project
app.post('/api/projects', async (req, res) => {
  const { userId, token, name, channelId, message, delay } = req.body;
  if (!userId || !token) return res.status(400).json({ error: 'userId and token required' });

  try {
    const project = await db.createProject({
      id: uuidv4(),
      userId,
      token,
      name: name || 'Project Baru',
      channelId: channelId || '',
      message: message || '',
      delay: delay ?? 5,
    });
    const { token: _, ...safe } = project;
    res.json(safe);
  } catch (err) {
    console.error('[DB ERR]', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Update project
app.put('/api/projects/:id', async (req, res) => {
  try {
    const existing = await db.getProject(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const { name, channelId, message, delay, token } = req.body;
    const p = await db.updateProject(req.params.id, { name, channelId, message, delay, token });
    const { token: _, ...safe } = p;
    res.json(safe);
  } catch (err) {
    console.error('[DB ERR]', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Delete project
app.delete('/api/projects/:id', async (req, res) => {
  try {
    stopJob(req.params.id);
    await db.deleteProject(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[DB ERR]', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Start autopost
app.post('/api/projects/:id/start', async (req, res) => {
  try {
    const p = await db.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (!p.channelId || !p.message) return res.status(400).json({ error: 'channelId and message required' });
    if (!p.token) return res.status(400).json({ error: 'No token for this project' });

    startJob(p);
    res.json({ ok: true, message: 'Autopost started' });
  } catch (err) {
    console.error('[DB ERR]', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Stop autopost
app.post('/api/projects/:id/stop', (req, res) => {
  stopJob(req.params.id);
  res.json({ ok: true, message: 'Autopost stopped' });
});

// Get project stats (live)
app.get('/api/projects/:id/stats', async (req, res) => {
  try {
    const p = await db.getProject(req.params.id);
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
  } catch (err) {
    console.error('[DB ERR]', err.message);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const projects = await db.getAllProjects();
    const activeJobs = Object.keys(runningJobs).length;
    res.json({ status: 'ok', activeJobs, projects: projects.length, uptime: process.uptime() });
  } catch (err) {
    res.status(500).json({ status: 'error', detail: err.message });
  }
});

// ── Start Server ───────────────────────────────────────
async function main() {
  await db.init();

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
}

main().catch(err => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});

if (process.env.VERCEL) {
  module.exports = app;
}

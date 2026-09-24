/**
 * db.js — Postgres (Neon) persistence layer.
 * Replaces the old data.json file so data survives restarts/redeploys.
 */

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('❌ DATABASE_URL is not set. Add it to your environment variables (Railway → Variables).');
}

const pool = new Pool({
  connectionString,
  ssl: connectionString && connectionString.includes('sslmode=require')
    ? undefined
    : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_accounts (
      id TEXT PRIMARY KEY,
      username TEXT,
      discriminator TEXT,
      avatar TEXT,
      token TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT,
      name TEXT,
      channel_id TEXT,
      message TEXT,
      delay INTEGER DEFAULT 5,
      running BOOLEAN DEFAULT FALSE,
      sent INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,
      last_sent TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  console.log('✅ Database ready (tables ensured)');
}

// ── Accounts ─────────────────────────────────────────
async function upsertAccount(account) {
  const { id, username, discriminator, avatar, token } = account;
  await pool.query(
    `INSERT INTO app_accounts (id, username, discriminator, avatar, token)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       discriminator = EXCLUDED.discriminator,
       avatar = EXCLUDED.avatar,
       token = EXCLUDED.token`,
    [id, username, discriminator, avatar, token]
  );
}

async function getAccount(id) {
  const { rows } = await pool.query('SELECT * FROM app_accounts WHERE id = $1', [id]);
  return rows[0] || null;
}

// ── Projects ─────────────────────────────────────────
function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    token: row.token,
    name: row.name,
    channelId: row.channel_id,
    message: row.message,
    delay: row.delay,
    running: row.running,
    sent: row.sent,
    failed: row.failed,
    lastSent: row.last_sent ? new Date(row.last_sent).toISOString() : null,
    lastError: row.last_error,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function getProjectsByUser(userId) {
  const { rows } = await pool.query('SELECT * FROM app_projects WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
  return rows.map(rowToProject);
}

async function getAllProjects() {
  const { rows } = await pool.query('SELECT * FROM app_projects');
  return rows.map(rowToProject);
}

async function getProject(id) {
  const { rows } = await pool.query('SELECT * FROM app_projects WHERE id = $1', [id]);
  return rowToProject(rows[0]);
}

async function createProject(project) {
  const { id, userId, token, name, channelId, message, delay } = project;
  const { rows } = await pool.query(
    `INSERT INTO app_projects (id, user_id, token, name, channel_id, message, delay, running, sent, failed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, 0, 0)
     RETURNING *`,
    [id, userId, token, name, channelId, message, delay]
  );
  return rowToProject(rows[0]);
}

async function updateProject(id, fields) {
  const map = { name: 'name', channelId: 'channel_id', message: 'message', delay: 'delay', token: 'token' };
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = $${i++}`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return getProject(id);
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE app_projects SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return rowToProject(rows[0]);
}

async function setProjectRunning(id, running) {
  const { rows } = await pool.query(
    'UPDATE app_projects SET running = $1 WHERE id = $2 RETURNING *',
    [running, id]
  );
  return rowToProject(rows[0]);
}

async function recordSuccess(id, timestamp) {
  const { rows } = await pool.query(
    `UPDATE app_projects
     SET sent = sent + 1, last_sent = $2
     WHERE id = $1
     RETURNING *`,
    [id, timestamp]
  );
  return rowToProject(rows[0]);
}

async function recordFailure(id, errorMessage, stop) {
  const { rows } = await pool.query(
    `UPDATE app_projects
     SET failed = failed + 1, last_error = $2, running = CASE WHEN $3 THEN FALSE ELSE running END
     WHERE id = $1
     RETURNING *`,
    [id, errorMessage, !!stop]
  );
  return rowToProject(rows[0]);
}

async function deleteProject(id) {
  await pool.query('DELETE FROM app_projects WHERE id = $1', [id]);
}

module.exports = {
  pool,
  init,
  upsertAccount,
  getAccount,
  getProjectsByUser,
  getAllProjects,
  getProject,
  createProject,
  updateProject,
  setProjectRunning,
  recordSuccess,
  recordFailure,
  deleteProject,
};

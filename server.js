const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;

// ── DB SETUP ────────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'rockstarz.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    episode_number  INTEGER NOT NULL,
    season          INTEGER NOT NULL DEFAULT 1,
    genre           TEXT NOT NULL DEFAULT 'Action',
    thumbnail       TEXT NOT NULL DEFAULT '',
    embed_dailymotion TEXT NOT NULL DEFAULT '',
    embed_rumble    TEXT NOT NULL DEFAULT '',
    is_special      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    nickname   TEXT NOT NULL DEFAULT 'Anonymous',
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_episodes_created ON episodes(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_episode ON comments(episode_id, created_at DESC);
`);

// ── SEED DEFAULTS ─────────────────────────────────────────────────────────
const setIfMissing = db.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`);
const DEFAULT_HASH = bcrypt.hashSync('rocky@17', 10);

setIfMissing.run('admin_password', DEFAULT_HASH);
setIfMissing.run('site_title', "The Voice of Rockstar'z");
setIfMissing.run('special_tile_thumbnail', '');
setIfMissing.run('special_tile_label', 'Special Episode — Season 1 · 18 Episodes · 4K');

// Seed 18 demo episodes if empty
const count = db.prepare(`SELECT COUNT(*) as c FROM episodes`).get();
if (count.c === 0) {
  const insert = db.prepare(`
    INSERT INTO episodes(id,title,episode_number,season,genre,thumbnail,embed_dailymotion,embed_rumble,is_special)
    VALUES(@id,@title,@episode_number,@season,@genre,@thumbnail,@embed_dailymotion,@embed_rumble,@is_special)
  `);
  const genres = ['Action','Cultivation','Romance','Comedy','Battle','Drama','Fantasy','Mystery'];
  for (let i = 1; i <= 18; i++) {
    insert.run({
      id: uuidv4(),
      title: `Battle Through the Heavens — Episode ${i}`,
      episode_number: i,
      season: 1,
      genre: genres[(i - 1) % genres.length],
      thumbnail: '',
      embed_dailymotion: '',
      embed_rumble: '',
      is_special: 1
    });
  }
}

// ── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','PATCH','DELETE'] }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const adminLimiter = rateLimit({ windowMs: 15*60*1000, max: 30, message: { error: 'Too many requests' } });
const commentLimiter = rateLimit({ windowMs: 60*1000, max: 10, message: { error: 'Too many comments' } });

// ── HELPERS ──────────────────────────────────────────────────────────────────
function getSetting(key) {
  const row = db.prepare(`SELECT value FROM settings WHERE key=?`).get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
}
function authAdmin(req, res) {
  const { password } = req.body;
  if (!password) { res.status(401).json({ error: 'Password required' }); return false; }
  const hash = getSetting('admin_password');
  if (!bcrypt.compareSync(password, hash)) { res.status(403).json({ error: 'Wrong password' }); return false; }
  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/site  — site meta
app.get('/api/site', (req, res) => {
  res.json({
    title: getSetting('site_title'),
    special_tile_thumbnail: getSetting('special_tile_thumbnail'),
    special_tile_label: getSetting('special_tile_label'),
  });
});

// GET /api/episodes  — all episodes, newest first
app.get('/api/episodes', (req, res) => {
  const { q, special } = req.query;
  let sql = `SELECT * FROM episodes WHERE 1=1`;
  const params = [];
  if (special !== undefined) { sql += ` AND is_special=?`; params.push(special === '1' ? 1 : 0); }
  if (q) { sql += ` AND (title LIKE ? OR genre LIKE ?)`; params.push(`%${q}%`, `%${q}%`); }
  sql += ` ORDER BY created_at DESC`;
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// GET /api/episodes/:id
app.get('/api/episodes/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM episodes WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// GET /api/comments/:episodeId
app.get('/api/comments/:episodeId', (req, res) => {
  const rows = db.prepare(`SELECT * FROM comments WHERE episode_id=? ORDER BY created_at DESC`).all(req.params.episodeId);
  res.json(rows);
});

// POST /api/comments  — post a comment (no auth needed)
app.post('/api/comments', commentLimiter, (req, res) => {
  const { episode_id, nickname, body } = req.body;
  if (!episode_id || !body?.trim()) return res.status(400).json({ error: 'episode_id and body required' });
  const ep = db.prepare(`SELECT id FROM episodes WHERE id=?`).get(episode_id);
  if (!ep) return res.status(404).json({ error: 'Episode not found' });
  const id = uuidv4();
  const name = (nickname?.trim() || 'Anonymous').substring(0, 30);
  db.prepare(`INSERT INTO comments(id,episode_id,nickname,body) VALUES(?,?,?,?)`).run(id, episode_id, name, body.trim().substring(0, 500));
  res.status(201).json({ id, episode_id, nickname: name, body: body.trim(), created_at: new Date().toISOString() });
});

// ── ADMIN AUTH CHECK ─────────────────────────────────────────────────────────
app.post('/api/admin/auth', adminLimiter, (req, res) => {
  if (!authAdmin(req, res)) return;
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES  (password in every request body)
// ════════════════════════════════════════════════════════════════════════════

// POST /api/admin/episodes  — create new episode
app.post('/api/admin/episodes', adminLimiter, (req, res) => {
  if (!authAdmin(req, res)) return;
  const { title, episode_number, season = 1, genre = 'Action',
    thumbnail = '', embed_dailymotion = '', embed_rumble = '', is_special = 0 } = req.body;
  if (!title || !episode_number) return res.status(400).json({ error: 'title and episode_number required' });
  const id = uuidv4();
  db.prepare(`
    INSERT INTO episodes(id,title,episode_number,season,genre,thumbnail,embed_dailymotion,embed_rumble,is_special)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(id, title, episode_number, season, genre, thumbnail, embed_dailymotion, embed_rumble, is_special ? 1 : 0);
  res.status(201).json(db.prepare(`SELECT * FROM episodes WHERE id=?`).get(id));
});

// PATCH /api/admin/episodes/:id  — update any field
app.patch('/api/admin/episodes/:id', adminLimiter, (req, res) => {
  if (!authAdmin(req, res)) return;
  const ep = db.prepare(`SELECT * FROM episodes WHERE id=?`).get(req.params.id);
  if (!ep) return res.status(404).json({ error: 'Not found' });
  const allowed = ['title','episode_number','season','genre','thumbnail','embed_dailymotion','embed_rumble','is_special'];
  const updates = [];
  const params = [];
  for (const field of allowed) {
    if (req.body[field] !== undefined) { updates.push(`${field}=?`); params.push(req.body[field]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
  updates.push(`updated_at=datetime('now')`);
  params.push(req.params.id);
  db.prepare(`UPDATE episodes SET ${updates.join(',')} WHERE id=?`).run(...params);
  res.json(db.prepare(`SELECT * FROM episodes WHERE id=?`).get(req.params.id));
});

// DELETE /api/admin/episodes/:id
app.delete('/api/admin/episodes/:id', adminLimiter, (req, res) => {
  if (!authAdmin(req, res)) return;
  const info = db.prepare(`DELETE FROM episodes WHERE id=?`).run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// POST /api/admin/settings  — update site settings
app.post('/api/admin/settings', adminLimiter, (req, res) => {
  if (!authAdmin(req, res)) return;
  const allowed = ['site_title','special_tile_thumbnail','special_tile_label'];
  for (const k of allowed) { if (req.body[k] !== undefined) setSetting(k, req.body[k]); }
  res.json({ ok: true });
});

// POST /api/admin/password  — change admin password
app.post('/api/admin/password', adminLimiter, (req, res) => {
  if (!authAdmin(req, res)) return;
  const { new_password } = req.body;
  if (!new_password || new_password.length < 4) return res.status(400).json({ error: 'New password too short' });
  setSetting('admin_password', bcrypt.hashSync(new_password, 10));
  res.json({ ok: true });
});

// DELETE /api/admin/comments/:id
app.delete('/api/admin/comments/:id', adminLimiter, (req, res) => {
  if(!authAdmin(req, res)) return;
  const info = db.prepare(`DELETE FROM comments WHERE id=?`).run(req.params.id);
  if(!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`🎙  Rockstar'z API running on port ${PORT}`));

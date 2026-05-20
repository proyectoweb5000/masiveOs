'use strict';

const express = require('express');
const initSqlJs = require('sql.js');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_PATH = process.env.DATABASE_PATH || process.env.DB_PATH || path.join(DATA_DIR, 'ea1fjz_cloud_os.sqlite');
const UPLOADS_PATH = process.env.UPLOADS_PATH || path.join(DATA_DIR, 'uploads');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiar1234';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOADS_PATH, { recursive: true });
fs.mkdirSync(path.join(UPLOADS_PATH, 'wallpapers'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_PATH, 'icons'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_PATH, 'files'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_PATH, 'backups'), { recursive: true });

let SQL = null;
let db = null;
let writeChain = Promise.resolve();

function persistDb() {
  const bytes = Buffer.from(db.export());
  fs.writeFileSync(DB_PATH, bytes);
}
function withWrite(fn) {
  writeChain = writeChain.then(async () => {
    const out = await fn();
    persistDb();
    return out;
  });
  return writeChain;
}
async function run(sql, params = []) {
  return withWrite(async () => {
    db.run(sql, params);
    const idRes = db.exec('SELECT last_insert_rowid() AS id');
    const lastID = idRes?.[0]?.values?.[0]?.[0] || 0;
    const changes = db.getRowsModified ? db.getRowsModified() : 0;
    return { lastID, changes };
  });
}
async function all(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res || !res.length) return [];
  const cols = res[0].columns;
  return res[0].values.map(v => Object.fromEntries(cols.map((c, i) => [c, v[i]])));
}
async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}
function nowIso() { return new Date().toISOString(); }
function safeName(name) { return String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 180); }
function makeHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = makeHash(password, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Date.now()) return null;
  return payload;
}
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map(x => {
    const i = x.indexOf('=');
    return [decodeURIComponent(x.slice(0, i).trim()), decodeURIComponent(x.slice(i + 1).trim())];
  }));
}
function setAuthCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `ea1fjz_os_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${secure}`);
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'ea1fjz_os_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}
async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req).ea1fjz_os_session;
    const payload = readToken(token);
    if (!payload) return res.status(401).json({ error: 'No autorizado' });
    const user = await get('SELECT id, username, role FROM users WHERE id=?', [payload.uid]);
    if (!user) return res.status(401).json({ error: 'Usuario no válido' });
    req.user = user;
    next();
  } catch (e) { next(e); }
}
async function initDb() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH) && fs.statSync(DB_PATH).size > 0) db = new SQL.Database(fs.readFileSync(DB_PATH));
  else db = new SQL.Database();

  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL,
    last_login TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await run(`CREATE TABLE IF NOT EXISTS desktop_icons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT '◻',
    type TEXT NOT NULL DEFAULT 'url',
    target TEXT NOT NULL DEFAULT '',
    x INTEGER NOT NULL DEFAULT 40,
    y INTEGER NOT NULL DEFAULT 110,
    width INTEGER NOT NULL DEFAULT 92,
    height INTEGER NOT NULL DEFAULT 92,
    visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'files',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS cloud_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    display_name TEXT NOT NULL,
    auth_type TEXT NOT NULL DEFAULT 'token',
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  await run(`CREATE TABLE IF NOT EXISTS remote_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'external',
    host TEXT NOT NULL DEFAULT '',
    port TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    launch_url TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const admin = await get('SELECT id FROM users WHERE username=?', ['admin']);
  if (!admin) await run('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)', ['admin', makeHash(DEFAULT_ADMIN_PASSWORD), 'admin', nowIso()]);
  const defaults = {
    os_title: 'EA1FJZ Cloud OS',
    os_subtitle: 'Sistema operativo web para dashboards, nube, meteorología, radio y archivos.',
    wallpaper: 'linear-gradient(135deg,#09111f 0%,#132b4f 45%,#0f172a 100%)',
    accent: '#2f7df6',
    meteo_url: 'https://open-meteo.com/',
    windy_url: 'https://www.windy.com/',
    dsn_url: 'https://eyes.nasa.gov/apps/dsn-now/dsn.html',
    meteoalarm_url: 'https://meteoalarm.org/en/live/region/ES'
  };
  for (const [key, value] of Object.entries(defaults)) {
    const exists = await get('SELECT key FROM system_config WHERE key=?', [key]);
    if (!exists) await run('INSERT INTO system_config(key,value,updated_at) VALUES(?,?,?)', [key, value, nowIso()]);
  }
  const countIcons = await get('SELECT COUNT(*) AS n FROM desktop_icons');
  if (!countIcons.n) {
    const icons = [
      ['Navegador', '🌐', 'browser', 'https://www.google.com/search?q=', 36, 120],
      ['Archivos', '📁', 'internal', 'files', 140, 120],
      ['Meteo & Radio', '📡', 'internal', 'meteo', 244, 120],
      ['Nube', '☁️', 'internal', 'cloud', 348, 120],
      ['Ayuda remota', '🖥️', 'internal', 'remote', 452, 120],
      ['Configuración', '⚙️', 'internal', 'settings', 556, 120],
      ['Windy', '🌬️', 'url', defaults.windy_url, 36, 240],
      ['DSN Now', '🛰️', 'url', defaults.dsn_url, 140, 240]
    ];
    for (const [title, icon, type, target, x, y] of icons) {
      await run('INSERT INTO desktop_icons(title,icon,type,target,x,y,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [title, icon, type, target, x, y, nowIso(), nowIso()]);
    }
  }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(UPLOADS_PATH, 'files')),
  filename: (req, file, cb) => cb(null, `${Date.now()}_${crypto.randomBytes(5).toString('hex')}_${safeName(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024 } });

app.use(express.json({ limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

app.post('/api/login', async (req, res, next) => {
  try {
    const { username = 'admin', password = '' } = req.body || {};
    const user = await get('SELECT * FROM users WHERE username=?', [username]);
    if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    await run('UPDATE users SET last_login=? WHERE id=?', [nowIso(), user.id]);
    const token = signToken({ uid: user.id, username: user.username, exp: Date.now() + 8 * 60 * 60 * 1000 });
    setAuthCookie(res, token);
    res.json({ ok: true, user: { username: user.username, role: user.role } });
  } catch (e) { next(e); }
});
app.post('/api/logout', (req, res) => { clearAuthCookie(res); res.json({ ok: true }); });
app.get('/api/session', requireAuth, (req, res) => res.json({ ok: true, user: req.user }));
app.post('/api/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    const user = await get('SELECT * FROM users WHERE id=?', [req.user.id]);
    if (!verifyPassword(currentPassword || '', user.password_hash)) return res.status(403).json({ error: 'Contraseña actual incorrecta.' });
    await run('UPDATE users SET password_hash=? WHERE id=?', [makeHash(newPassword), req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/health', async (req, res) => {
  let writable = false;
  try { fs.accessSync(path.dirname(DB_PATH), fs.constants.W_OK); writable = true; } catch (_) {}
  res.json({ ok: true, dbPath: DB_PATH, uploadsPath: UPLOADS_PATH, writable, time: nowIso(), sqliteEngine: 'sql.js' });
});
app.get('/api/config', requireAuth, async (req, res, next) => {
  try {
    const rows = await all('SELECT key,value FROM system_config');
    res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
  } catch (e) { next(e); }
});
app.post('/api/config', requireAuth, async (req, res, next) => {
  try {
    for (const [key, value] of Object.entries(req.body || {})) {
      await run('INSERT INTO system_config(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', [key, String(value ?? ''), nowIso()]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/icons', requireAuth, async (req, res, next) => {
  try { res.json(await all('SELECT * FROM desktop_icons WHERE visible=1 ORDER BY id')); } catch (e) { next(e); }
});
app.post('/api/icons', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    const result = await run('INSERT INTO desktop_icons(title,icon,type,target,x,y,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [b.title || 'Nuevo acceso', b.icon || '◻', b.type || 'url', b.target || '', Number(b.x || 60), Number(b.y || 120), nowIso(), nowIso()]);
    res.json(await get('SELECT * FROM desktop_icons WHERE id=?', [result.lastID]));
  } catch (e) { next(e); }
});
app.put('/api/icons/:id', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    await run('UPDATE desktop_icons SET title=?,icon=?,type=?,target=?,x=?,y=?,updated_at=? WHERE id=?', [b.title || 'Acceso', b.icon || '◻', b.type || 'url', b.target || '', Number(b.x || 60), Number(b.y || 120), nowIso(), req.params.id]);
    res.json(await get('SELECT * FROM desktop_icons WHERE id=?', [req.params.id]));
  } catch (e) { next(e); }
});
app.delete('/api/icons/:id', requireAuth, async (req, res, next) => {
  try { await run('UPDATE desktop_icons SET visible=0,updated_at=? WHERE id=?', [nowIso(), req.params.id]); res.json({ ok: true }); } catch (e) { next(e); }
});
app.get('/api/files', requireAuth, async (req, res, next) => {
  try { res.json(await all('SELECT * FROM files ORDER BY id DESC LIMIT 300')); } catch (e) { next(e); }
});
app.post('/api/files/upload', requireAuth, upload.single('file'), async (req, res, next) => {
  try {
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'No se recibió archivo.' });
    const rel = `files/${f.filename}`;
    const result = await run('INSERT INTO files(original_name,stored_name,relative_path,mime_type,size_bytes,category,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', [f.originalname, f.filename, rel, f.mimetype, f.size, 'files', nowIso(), nowIso()]);
    res.json(await get('SELECT * FROM files WHERE id=?', [result.lastID]));
  } catch (e) { next(e); }
});
app.get('/api/files/download/:id', requireAuth, async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM files WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).send('No encontrado');
    res.download(path.join(UPLOADS_PATH, row.relative_path), row.original_name);
  } catch (e) { next(e); }
});
app.delete('/api/files/:id', requireAuth, async (req, res, next) => {
  try {
    const row = await get('SELECT * FROM files WHERE id=?', [req.params.id]);
    if (row) { try { fs.unlinkSync(path.join(UPLOADS_PATH, row.relative_path)); } catch (_) {} }
    await run('DELETE FROM files WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.get('/api/cloud/accounts', requireAuth, async (req, res, next) => {
  try { res.json(await all('SELECT id,provider,display_name,auth_type,enabled,created_at,updated_at FROM cloud_accounts ORDER BY id DESC')); } catch (e) { next(e); }
});
app.post('/api/cloud/accounts', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    await run('INSERT INTO cloud_accounts(provider,display_name,auth_type,config_json,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', [b.provider || 'GitHub', b.display_name || 'Cuenta nube', b.auth_type || 'token', JSON.stringify(b.config || {}), b.enabled === false ? 0 : 1, nowIso(), nowIso()]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.delete('/api/cloud/accounts/:id', requireAuth, async (req, res, next) => { try { await run('DELETE FROM cloud_accounts WHERE id=?', [req.params.id]); res.json({ ok: true }); } catch (e) { next(e); } });
app.get('/api/remote/connections', requireAuth, async (req, res, next) => {
  try { res.json(await all('SELECT * FROM remote_connections ORDER BY id DESC')); } catch (e) { next(e); }
});
app.post('/api/remote/connections', requireAuth, async (req, res, next) => {
  try {
    const b = req.body || {};
    await run('INSERT INTO remote_connections(name,protocol,host,port,username,launch_url,notes,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [b.name || 'Equipo remoto', b.protocol || 'external', b.host || '', b.port || '', b.username || '', b.launch_url || '', b.notes || '', b.enabled === false ? 0 : 1, nowIso(), nowIso()]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.delete('/api/remote/connections/:id', requireAuth, async (req, res, next) => { try { await run('DELETE FROM remote_connections WHERE id=?', [req.params.id]); res.json({ ok: true }); } catch (e) { next(e); } });
app.get('/api/db-backup', requireAuth, async (req, res, next) => {
  try {
    persistDb();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `ea1fjz_cloud_os_backup_${stamp}.sqlite`;
    res.download(DB_PATH, name);
  } catch (e) { next(e); }
});
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Error interno' });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`EA1FJZ Cloud OS escuchando en puerto ${PORT}. DB: ${DB_PATH}`));
}).catch(err => { console.error(err); process.exit(1); });

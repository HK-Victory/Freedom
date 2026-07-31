/**
 * db.js — 纯 JS 存储引擎（基于 sql.js / SQLite WASM）
 *
 * 为什么换掉 better-sqlite3？
 *   - better-sqlite3 是原生模块（.node），在 Vercel 免费(serverless) 环境难以打包且不可用；
 *   - Vercel serverless 文件系统只读（除 /tmp），本地 SQLite 文件无法持久化；
 *   - sql.js 是 SQLite 的纯 JS(WASM) 移植，API 与 SQL 语法 100% 兼容，
 *     且可通过 KV / 文件将整个数据库序列化持久化，完美适配 serverless。
 *
 * 对外暴露的接口与旧 db.js 完全一致：
 *   - db.prepare(sql).all/get/run/exec  兼容 better-sqlite3 用法（支持 @命名参数 与 ? 位置参数）
 *   - getEmailConfig / upsertEmailConfig
 *   - initDefaultAdmin / getUserById / getUserByUsername / listUsers / createUser / updateUser / deleteUser
 *   - init() / ensureReady()
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { put, list, del } = require('@vercel/blob');

// 内联资源（打包进函数，避免 serverless 环境下找不到 WASM / seed 文件）
// Vercel 的打包器(nft)无法静态追踪运行时路径，sql-wasm.wasm 与 data/seed.b64
// 经常不会被打进函数包，因此把它们内联为 base64 模块随代码一起分发。
let embeddedWasm = null;
let embeddedSeed = null;
try { embeddedWasm = require('./api/embedded-wasm'); } catch (e) { /* 本地未生成时回退到文件定位 */ }
try { embeddedSeed = require('./api/embedded-seed'); } catch (e) { /* 同上 */ }

const isVercel = !!process.env.VERCEL;
const SEED_PATH = path.join(__dirname, 'data', 'seed.b64');
const LOCAL_STORE = isVercel
  ? path.join('/tmp', 'task-tracker-store')
  : path.join(__dirname, 'data', 'db.store');

// Vercel Blob（推荐的主持久化方案）：把整个 sql.js 数据库文件存到 Blob，
// 跨部署 / 重启都不会丢失。
// 关键：@vercel/blob 在 serverless 函数执行时从 process.env.BLOB_READ_WRITE_TOKEN 读取凭据
// （storeId 由 token 自身解析，SDK 并不读取 BLOB_STORE_ID 环境变量）。
// 该变量必须存在于 Vercel「运行时」环境——由 .github/workflows/deploy.yml 在部署时通过
// `vercel deploy -e` 注入（读取仓库 Secrets/Variables 中的 BLOB_READ_WRITE_TOKEN），
// 切勿写进 vercel.json（会泄露密钥、且不会进入运行时）。
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
const BLOB_STORE_ID = process.env.BLOB_STORE_ID || '';
const BLOB_KEY = 'freedom-db.sqlite';

// Vercel KV（基于 Upstash）：作为 Blob 不可用时的次级持久化。
// 在 Vercel 后台 “Storage” 中一键创建 KV 后，以下两个环境变量会自动注入，
// 也可手动在环境变量里填写 KV_REST_API_URL / KV_REST_API_TOKEN。
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_KEY = 'task-tracker-db';

let SQL = null;
let _db = null;
let _ready = null;

// 持久化状态（用于运行态诊断，可被 /api/storage/status 读取）
let _loadSource = 'none';   // 'blob' | 'kv' | 'local' | 'seed' | 'embedded' | 'fresh' | 'none'
let _lastSaveAt = 0;
let _lastSaveOk = null;
let _lastSaveError = null;

// -------- 表结构（幂等，首次启动创建）--------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT UNIQUE NOT NULL,
  category TEXT,
  name TEXT NOT NULL,
  requirements TEXT,
  priority TEXT,
  start_date TEXT,
  end_date TEXT,
  owner TEXT,
  resources TEXT,
  dependency TEXT,
  status TEXT DEFAULT 'pending',
  sheet_name TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT UNIQUE NOT NULL,
  content TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  updated_by TEXT DEFAULT '系统',
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);
CREATE TABLE IF NOT EXISTS email_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_user TEXT,
  smtp_pass TEXT,
  smtp_secure INTEGER DEFAULT 1,
  sender_name TEXT DEFAULT '闻道任务提醒',
  enabled INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS email_recipients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  name TEXT,
  scope TEXT DEFAULT 'all',
  task_ids TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  reminder_date TEXT NOT NULL,
  days_before INTEGER,
  sent INTEGER DEFAULT 0,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);
CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  action TEXT,
  content TEXT,
  operator TEXT DEFAULT '系统',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS task_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  note TEXT,
  recorded_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT DEFAULT 'user' CHECK(role IN ('admin','user')),
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

// -------- 持久化（跨部署不丢失：优先 Vercel Blob，其次 KV，本地 /tmp 仅作同实例缓存）--------
function exportBytes() {
  if (!_db) return null;
  try { return Buffer.from(_db.export()); } catch (e) { return null; }
}

function persistLocal() {
  if (!_db) return;
  try { fs.writeFileSync(LOCAL_STORE, exportBytes()); } catch (e) { /* 只读或不可用，忽略 */ }
}

function persistKV() {
  if (!_db || !KV_URL) return;
  const b64 = exportBytes().toString('base64');
  // 最佳努力：异步、不阻塞请求
  fetch(`${KV_URL}/set/${KV_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
    body: b64
  }).catch(e => console.error('[KV] 保存失败:', e.message));
}

async function persistBlob() {
  if (!_db) return false;
  if (!BLOB_TOKEN) {
    // 凭据缺失：无法持久化，必须显式记录原因，避免「静默假成功」让数据在重新部署后丢失
    _lastSaveOk = false;
    _lastSaveError = 'BLOB_READ_WRITE_TOKEN 未配置：数据仅存于本次运行内存，重新部署/重启将丢失。' +
      '请在 Vercel「Settings → Environment Variables」配置（Production 作用域），或在 GitHub Actions 变量/Secrets 中填写后重新部署。';
    return false;
  }
  try {
    const bytes = exportBytes();
    if (!bytes) return false;
    // @vercel/blob 2.x 支持 access: 'private' | 'public'。当 Vercel Blob store 在后台被配置为
    // private 时，写入必须带 access: 'private'，否则服务端报
    // "Cannot use public access on a private store"。
    try {
      await put(BLOB_KEY, bytes, {
        access: 'private',
        token: BLOB_TOKEN,
        allowOverwrite: true,
        contentType: 'application/octet-stream'
      });
    } catch (overwriteErr) {
      // 兜底：若因历史快照访问模式不一致（如旧 public blob 无法被 private 直接覆盖）导致失败，
      // 先删除旧快照再以 private 重新写入，避免再次落盘失败。
      console.warn('[Blob] 覆盖写入失败，尝试删除旧快照后重写:', overwriteErr && overwriteErr.message);
      try {
        const { blobs } = await list({ token: BLOB_TOKEN, prefix: BLOB_KEY, limit: 1 });
        if (blobs && blobs.length) {
          await del(blobs[0].url, { token: BLOB_TOKEN });
        }
      } catch (delErr) {
        console.warn('[Blob] 删除旧快照失败（忽略）:', delErr && delErr.message);
      }
      await put(BLOB_KEY, bytes, {
        access: 'private',
        token: BLOB_TOKEN,
        contentType: 'application/octet-stream'
      });
    }
    _lastSaveAt = Date.now();
    _lastSaveOk = true;
    _lastSaveError = null;
    return true;
  } catch (e) {
    _lastSaveOk = false;
    _lastSaveError = 'Blob 写入失败：' + (e && e.message ? e.message : String(e));
    console.error('[Blob] 保存失败:', e && e.message);
    return false;
  }
}

// 最佳努力的异步保存（请求处理中调用，不阻塞响应）
function schedulePersist() {
  persistLocal();
  persistKV();
  if (BLOB_TOKEN) persistBlob().catch(e => console.error('[Blob] 后台保存失败:', e.message));
}

// 同步落盘（在响应返回前 await，确保部署/重启不丢数据）
async function flush() {
  if (!_db) return;
  if (BLOB_TOKEN) await persistBlob();
  persistLocal();
  persistKV();
}

async function loadFromKV() {
  if (!KV_URL) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${KV_KEY}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const j = await r.json();
    if (j && j.result != null) return Buffer.from(j.result, 'base64');
  } catch (e) {
    console.error('[KV] 读取失败:', e.message);
  }
  return null;
}

async function loadFromBlob() {
  if (!BLOB_TOKEN) return null;
  try {
    const { blobs } = await list({ token: BLOB_TOKEN, prefix: BLOB_KEY, limit: 1 });
    if (!blobs || !blobs.length) return null;
    const r = await fetch(blobs[0].downloadUrl);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    console.error('[Blob] 读取失败:', e.message);
  }
  return null;
}

// -------- 初始化（异步，serverless 冷启动只跑一次）--------
async function init() {
  if (_db) return;
  if (!SQL) {
    const sqlJsPath = path.dirname(require.resolve('sql.js'));
    try {
      // 优先用内联 wasm，完全不依赖文件系统定位（Vercel 上最稳）
      if (embeddedWasm) {
        SQL = await initSqlJs({ wasmBinary: Buffer.from(embeddedWasm, 'base64') });
      } else {
        throw new Error('no embedded wasm');
      }
    } catch (e) {
      console.error('[sql.js] 内联 wasm 加载失败，回退文件定位:', e.message);
      SQL = await initSqlJs({ locateFile: (file) => path.join(sqlJsPath, file) });
    }
  }

  let bytes = null;
  let source = 'none';
  // 1) 优先从 Vercel Blob 读取（跨部署持久化的主存储）
  bytes = await loadFromBlob();
  if (bytes && bytes.length) source = 'blob';
  // 2) 其次 KV（跨实例最新数据）
  if (!bytes || !bytes.length) {
    bytes = await loadFromKV();
    if (bytes && bytes.length) source = 'kv';
  }
  // 3) 本地文件（同一实例内的可靠副本）
  if (!bytes || !bytes.length) {
    if (fs.existsSync(LOCAL_STORE)) {
      try { bytes = fs.readFileSync(LOCAL_STORE); if (bytes && bytes.length) source = 'local'; } catch (e) { bytes = null; }
    }
  }
  // 4) 仓库内置种子数据（冷启动兜底，已含 21 项任务 + 超管账号）
  if (!bytes || !bytes.length) {
    if (fs.existsSync(SEED_PATH)) {
      try { bytes = Buffer.from(fs.readFileSync(SEED_PATH, 'utf8'), 'base64'); if (bytes && bytes.length) source = 'seed'; } catch (e) { bytes = null; }
    }
  }
  // 5) 内联种子（打包进函数，避免 serverless 文件系统找不到 data/seed.b64）
  if (!bytes || !bytes.length) {
    if (embeddedSeed) {
      try { bytes = Buffer.from(embeddedSeed, 'base64'); if (bytes && bytes.length) source = 'embedded'; } catch (e) { bytes = null; }
    }
  }
  if (!bytes || !bytes.length) source = 'fresh';

  _db = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database();
  _db.run(SCHEMA);

  // 确保超管账号存在（种子已含，这里幂等兜底）
  initDefaultAdmin();
  _loadSource = source;

  // —— 诊断日志：清楚暴露本次启动从哪个存储加载、Blob 是否可用 ——
  if (!BLOB_TOKEN) {
    console.warn('[存储] ⚠️ BLOB_READ_WRITE_TOKEN 未配置：数据仅存于本次运行内存，重新部署/重启将丢失！' +
      '请在 Vercel 项目「Settings → Environment Variables」中配置（务必勾选 Production 环境）。');
  } else {
    const storeNote = BLOB_STORE_ID
      ? `BLOB_STORE_ID=${BLOB_STORE_ID}`
      : 'BLOB_STORE_ID 未设置（SDK 将从 token 解析目标 store）';
    const note = source === 'blob'
      ? '（已从 Blob 恢复历史数据 ✅��'
      : '（未找到历史快照，使用种子/本地基线）';
    console.log(`[存储] Blob 已配置。${storeNote}。本次加载来源: ${source} ${note}`);
  }
  // 首次启动（种子/空库）且 Blob 可用时，立即把基线落盘，避免后续冷启动反复重置
  if (BLOB_TOKEN && (source === 'seed' || source === 'embedded' || source === 'fresh')) {
    persistBlob()
      .then(ok => console.log(`[存储] 基线数据已${ok ? '保存' : '保存失败'}到 Blob`))
      .catch(() => {});
  }
}

function ensureReady() {
  if (!_ready) _ready = init();
  return _ready;
}

// -------- better-sqlite3 兼容包装 --------
function getDb() {
  if (!_db) throw new Error('数据库尚未初始化，请先 await ensureReady()');
  return _db;
}

// 将 better-sqlite3 风格的参数统一转换为「位置参数 ?」再绑定。
// 原因：sql.js 的对象式命名绑定（@x / :x）不稳定，而纯位置 ? 绑定可靠。
// 这里在 wrapper 内把 SQL 中的 @name 占位符替换为 ?，并按出现顺序
// 从命名对象中取出对应值，转为位置数组，从而复用已验证可用的位置绑定路径。
function normalizeSql(sql, args) {
  const atNames = [];
  const re = /@([a-zA-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(sql)) !== null) atNames.push(m[1]);
  const newSql = sql.replace(/@([a-zA-Z0-9_]+)/g, '?');

  let newArgs = args;
  const singleObj = args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]);

  if (atNames.length) {
    // SQL 含 @命名占位符 → 从对象按顺序取值
    if (singleObj) {
      const p = args[0];
      newArgs = atNames.map((n) => {
        if (p[n] !== undefined) return p[n];
        if (p['@' + n] !== undefined) return p['@' + n];
        return null;
      });
    }
    // 否则保持原位置参数（args 本身就是标量数组）
  } else if (singleObj) {
    // SQL 没有任何占位符，但调用方传了一个对象（如空 filters {}) —— 直接忽略，不绑定
    newArgs = [];
  }
  return { sql: newSql, args: newArgs };
}

function wrapStmt(sql) {
  return {
    all: (...args) => {
      const { sql: s, args: a } = normalizeSql(sql, args);
      const stmt = getDb().prepare(s);
      if (a.length) stmt.bind(a.map((x) => (x === undefined ? null : x)));
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      stmt.free();
      return out;
    },
    get: (...args) => {
      const { sql: s, args: a } = normalizeSql(sql, args);
      const stmt = getDb().prepare(s);
      if (a.length) stmt.bind(a.map((x) => (x === undefined ? null : x)));
      let row = null;
      if (stmt.step()) row = stmt.getAsObject();
      stmt.free();
      return row;
    },
    run: (...args) => {
      const { sql: s, args: a } = normalizeSql(sql, args);
      const stmt = getDb().prepare(s);
      if (a.length) stmt.bind(a.map((x) => (x === undefined ? null : x)));
      stmt.run();
      stmt.free();
      let lastInsertRowid = null;
      let changes = 0;
      try {
        const r = getDb().exec('SELECT last_insert_rowid() AS id');
        if (r.length && r[0].values.length) lastInsertRowid = r[0].values[0][0];
        changes = getDb().getRowsModified();
      } catch (e) { /* ignore */ }
      schedulePersist();
      return { lastInsertRowid, changes };
    }
  };
}

const db = {
  prepare: (sql) => wrapStmt(sql),
  exec: (sql) => { getDb().exec(sql); },
  run: (sql, ...args) => wrapStmt(sql).run(...args),
  pragma: () => ({})
};

// -------- 邮件配置 --------
function getEmailConfig() {
  const row = db.prepare('SELECT * FROM email_config WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO email_config (id) VALUES (1)').run();
    return { id: 1, smtp_host: '', smtp_port: 465, smtp_user: '', smtp_pass: '', smtp_secure: 1, sender_name: '闻道任务提醒', enabled: 0 };
  }
  return row;
}

function upsertEmailConfig(cfg) {
  db.prepare(`
    INSERT INTO email_config (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, sender_name, enabled)
    VALUES (1, @smtp_host, @smtp_port, @smtp_user, @smtp_pass, @smtp_secure, @sender_name, @enabled)
    ON CONFLICT(id) DO UPDATE SET
      smtp_host=@smtp_host, smtp_port=@smtp_port, smtp_user=@smtp_user,
      smtp_pass=@smtp_pass, smtp_secure=@smtp_secure, sender_name=@sender_name, enabled=@enabled
  `).run(cfg);
}

// -------- 用户管理 --------
function initDefaultAdmin() {
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
      .run('admin', hash, '系统管理员', 'admin');
    console.log('[用户] 默认超管账号已创建: admin / admin123');
  }
}

function getUserById(id) {
  return db.prepare('SELECT id, username, display_name, role, enabled, created_at FROM users WHERE id = ?').get(id);
}

function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function listUsers() {
  return db.prepare('SELECT id, username, display_name, role, enabled, created_at, updated_at FROM users ORDER BY id ASC').all();
}

function createUser(username, passwordHash, displayName, role) {
  return db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, displayName || username, role || 'user');
}

function updateUser(id, fields) {
  const sets = [];
  const params = {};
  if (fields.display_name !== undefined) { sets.push('display_name = @display_name'); params.display_name = fields.display_name; }
  if (fields.role !== undefined) { sets.push('role = @role'); params.role = fields.role; }
  if (fields.enabled !== undefined) { sets.push('enabled = @enabled'); params.enabled = fields.enabled ? 1 : 0; }
  if (fields.password_hash !== undefined) { sets.push('password_hash = @password_hash'); params.password_hash = fields.password_hash; }
  sets.push("updated_at = datetime('now','localtime')");
  params.id = id;
  return db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// -------- 提醒设置（页面可配置的定时发送时间 / 提前提醒天数）--------
function getSetting(key, def) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : def;
  } catch (e) { return def; }
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, String(value), String(value));
}

function getReminderSettings() {
  const enabled = getSetting('reminder_enabled', '0') === '1';
  let hour = parseInt(getSetting('reminder_hour', '9'), 10);
  if (isNaN(hour) || hour < 0 || hour > 23) hour = 9;
  let minute = parseInt(getSetting('reminder_minute', '0'), 10);
  if (isNaN(minute) || minute < 0 || minute > 59) minute = 0;
  let leadDays;
  try { leadDays = JSON.parse(getSetting('reminder_lead_days', '[1,3,7]')); } catch (e) { leadDays = [1, 3, 7]; }
  if (!Array.isArray(leadDays) || leadDays.length === 0) leadDays = [1, 3, 7];
  return { enabled, hour, minute, leadDays };
}

function setReminderSettings(s) {
  if (!s || typeof s !== 'object') return;
  setSetting('reminder_enabled', s.enabled ? '1' : '0');
  setSetting('reminder_hour', String(Number.isFinite(s.hour) ? s.hour : 9));
  setSetting('reminder_minute', String(Number.isFinite(s.minute) ? s.minute : 0));
  const days = Array.isArray(s.leadDays) && s.leadDays.length ? s.leadDays : [1, 3, 7];
  setSetting('reminder_lead_days', JSON.stringify(days));
}

// -------- 存储状态诊断（供 /api/storage/status 与设置页展示）--------
async function getStorageStatus() {
  let counts = null;
  try {
    const r = getDb().exec(
      'SELECT (SELECT COUNT(*) FROM tasks) AS tasks, ' +
      '(SELECT COUNT(*) FROM users) AS users, ' +
      '(SELECT COUNT(*) FROM email_recipients) AS recipients'
    );
    if (r.length) {
      const cols = r[0].columns;
      const vals = r[0].values[0];
      const o = {};
      cols.forEach((c, i) => { o[c] = vals[i]; });
      counts = o;
    }
  } catch (e) { /* ignore */ }

  // 真实连接探测：用当前 token 实际 list 一次 Blob，
  // 确认能否连通、且目标 store 中是否已存在数据库快照。
  // 避免「变量存在但实际连不通」被静默掩盖（此前数据丢失的主因）。
  const tokenConfigured = !!BLOB_TOKEN;
  const storeIdConfigured = !!BLOB_STORE_ID;
  let connected = false;
  let blobExists = false;
  let connectError = null;
  if (tokenConfigured) {
    try {
      const { blobs } = await list({ token: BLOB_TOKEN, prefix: BLOB_KEY, limit: 1 });
      connected = true;
      blobExists = !!(blobs && blobs.length);
    } catch (e) {
      connected = false;
      connectError = e && e.message ? e.message : String(e);
    }
  }
  return {
    vercel: isVercel,
    blob: {
      tokenConfigured,
      storeIdConfigured,
      storeId: storeIdConfigured ? BLOB_STORE_ID : null,
      configured: tokenConfigured,
      connected,
      blobExists,
      connectError,
      lastSaveAt: _lastSaveAt ? new Date(_lastSaveAt).toISOString() : null,
      lastSaveOk: _lastSaveOk,
      lastSaveError: _lastSaveError
    },
    kv: { configured: !!KV_URL },
    loadSource: _loadSource,
    counts
  };
}

module.exports = {
  db,
  getEmailConfig,
  upsertEmailConfig,
  getSetting,
  setSetting,
  getReminderSettings,
  setReminderSettings,
  getStorageStatus,
  flush,
  initDefaultAdmin,
  getUserById,
  getUserByUsername,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  init,
  ensureReady
};

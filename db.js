/**
 * db.js — 纯 JS 存储引擎（基于 sql.js / SQLite WASM）
 *
 * 为什么换掉 better-sqlite3？
 *   - better-sqlite3 是原生模块（.node），在 serverless 环境难以打包且不可用；
 *   - serverless 文件系统只读（除 /tmp），本地 SQLite 文件无法持久化；
 *   - sql.js 是 SQLite 的纯 JS(WASM) 移植，API 与 SQL 语法 100% 兼容，
 *     且可通过 KV / 文件将整个数据库序列化持久化，完美适配 EdgeOne/Vercel serverless。
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

// 内联资源（打包进函数，避免 serverless 环境下找不到 WASM / seed 文件）
// 打包器(nft)无法静态追踪运行时路径，sql-wasm.wasm 与 data/seed.b64
// 经常不会被打进函数包，因此把它们内联为 base64 模块随代码一起分发。
let embeddedWasm = null;
let embeddedSeed = null;
try { embeddedWasm = require('./api/embedded-wasm'); } catch (e) { /* 本地未生成时回退到文件定位 */ }
try { embeddedSeed = require('./api/embedded-seed'); } catch (e) { /* 同上 */ }

// 通用 serverless 检测：Vercel / EdgeOne 环境变量，或 data 目录不可写（典型只读 FS）
function isDataDirWritable() {
  try { fs.accessSync(path.join(__dirname, 'data'), fs.constants.W_OK); return true; }
  catch (e) { return false; }
}
const isServerless = !!process.env.VERCEL || !!process.env.EDGEONE_PAGES || !isDataDirWritable();
const SEED_PATH = path.join(__dirname, 'data', 'seed.b64');
const LOCAL_STORE = isServerless
  ? path.join('/tmp', 'task-tracker-store')
  : path.join(__dirname, 'data', 'db.store');

// Vercel KV（基于 Upstash，免费额度足够小团队使用）
// 在 Vercel 后台 “Storage” 中一键创建 KV 后，以下两个环境变量会自动注入，
// 也可手动在环境变量里填写 KV_REST_API_URL / KV_REST_API_TOKEN。
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_KEY = 'task-tracker-db';

let SQL = null;
let _db = null;
let _ready = null;

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
`;

// -------- 持久化 --------
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
  // 最佳努力：异步、不阻塞请求；serverless 函数在响应后通常仍存活片刻完成写入
  fetch(`${KV_URL}/set/${KV_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
    body: b64
  }).catch(e => console.error('[KV] 保存失败:', e.message));
}

function schedulePersist() {
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
  // 1) 优先从 KV 读取（跨实例最新数据）
  bytes = await loadFromKV();
  // 2) 本地文件（同一实例内的可靠副本）
  if (!bytes && fs.existsSync(LOCAL_STORE)) {
    try { bytes = fs.readFileSync(LOCAL_STORE); } catch (e) { bytes = null; }
  }
  // 3) 仓库内置种子数据（冷启动兜底，已含 21 项任务 + 超管账号）
  if (!bytes && fs.existsSync(SEED_PATH)) {
    try { bytes = Buffer.from(fs.readFileSync(SEED_PATH, 'utf8'), 'base64'); } catch (e) { bytes = null; }
  }
  // 4) 内联种子（打包进函数，避免 serverless 文件系统找不到 data/seed.b64）
  if (!bytes && embeddedSeed) {
    try { bytes = Buffer.from(embeddedSeed, 'base64'); } catch (e) { bytes = null; }
  }

  _db = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database();
  _db.run(SCHEMA);

  // 确保超管账号存在（种子已含，这里幂等兜底）
  initDefaultAdmin();

  // 首次写入本地/KV，便于后续冷启动命中
  schedulePersist();
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

module.exports = {
  db,
  getEmailConfig,
  upsertEmailConfig,
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

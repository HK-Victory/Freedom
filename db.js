/**
 * db.js — Supabase Postgres 存储后端（原生关系表）
 *
 * 迁移说明：
 *   - 旧版基于 sql.js(WASM) 把整个数据库序列化为单文件存 Vercel Blob，存在「多实例内存库互相覆盖、
 *     重部署读不到快照而假丢失」等顽疾。
 *   - 现改为直连 Supabase 的 Postgres 数据库（通过 pg 驱动 + SUPABASE_DB_URL 连接串）。
 *     数据真正以关系表形式存放在 Supabase 上，所有实例共享同一数据源，彻底消除快照/对账/flush 复杂度。
 *
 * 对外接口保持与旧 db.js 类似：
 *   - db.prepare(sql).all/get/run   —— 兼容旧调用方式，但均为 async（需 await）
 *   - getEmailConfig / upsertEmailConfig
 *   - initDefaultAdmin / getUserById / getUserByUsername / listUsers / createUser / updateUser / deleteUser
 *   - getSetting / setSetting / getReminderSettings / setReminderSettings
 *   - getStorageStatus / getLastSave / init / ensureReady
 *
 * SQL 方言：下游代码沿用 SQLite 风格 SQL，这里在「翻译层」把它转成 Postgres 可执行的语句，
 * 从而 server.js / excel-reader.js / scheduler.js / email.js 的业务 SQL 几乎零改动（仅加 await）。
 */

const pg = require('pg');
const { Pool } = pg;
const bcrypt = require('bcryptjs');

// pg 默认把 int8/BIGSERIAL（OID 20）解析成「字符串」以防大数精度丢失，
// 但本项目所有自增主键都远小于 2^53，且业务代码存在 `parseInt(req.params.id) === req.user.id`
// 这类严格相等比较（例如「不能删除自己的账号」保护），字符串 id 会让判断静默失效。
// 因此统一按数值解析，保持与旧 SQLite 后端一致的类型语义。COUNT(*) 同样受益（返回 number）。
if (pg.types && typeof pg.types.setTypeParser === 'function') {
  pg.types.setTypeParser(20, (v) => (v === null || v === undefined ? null : parseInt(v, 10)));
}

const CONNECTION_STRING = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
const POOL_CONFIGURED = !!CONNECTION_STRING;

let pool = null;
function getPool() {
  if (!pool) {
    if (!CONNECTION_STRING) {
      throw new Error('SUPABASE_DB_URL 未配置：数据无法持久化。请在 Vercel 环境变量中配置 Supabase Postgres 连接串（Settings → Database → Connection string，直连 5432）。');
    }
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      ssl: { rejectUnauthorized: false }, // Supabase 要求 SSL
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    });
    pool.on('error', (err) => {
      console.error('[pg] 连接池异常:', err && err.message);
    });
  }
  return pool;
}

// -------- 持久化状态（用于运行态诊断）--------
let _lastWriteOk = null;     // 最近一次写是否成功（null=尚无写入）
let _lastWriteError = null;
let _lastWriteAt = 0;
let _schemaReady = false;

// =====================================================================
//  SQL 翻译层：SQLite 风格 → Postgres
// =====================================================================

// 占位符：?（位置参数）与 @name（命名参数）统一转为 $1, $2, ...
// 返回 { sql, values }
function translatePlaceholders(sql, args) {
  const hasNamed = /@([a-zA-Z0-9_]+)/.test(sql);
  if (hasNamed) {
    // 命名参数：调用方传入单个对象 { name: value }
    const obj = (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]))
      ? args[0]
      : {};
    let idx = 0;
    const values = [];
    const newSql = sql.replace(/@([a-zA-Z0-9_]+)/g, (m, name) => {
      idx++;
      const v = obj[name] !== undefined ? obj[name] : (obj['@' + name] !== undefined ? obj['@' + name] : null);
      values.push(v);
      return '$' + idx;
    });
    return { sql: newSql, values };
  }
  // 位置参数：? → $n
  let idx = 0;
  const newSql = sql.replace(/\?/g, () => {
    idx++;
    return '$' + idx;
  });
  // 调用方可能直接传数组，或逐个标量
  const raw = (args.length === 1 && Array.isArray(args[0])) ? args[0] : Array.from(args);
  // 关键：按 SQL 中实际出现的最大 $n 截断入参。
  // 业务代码存在「动态拼 WHERE 条件」的写法（如 GET /api/tasks 无筛选时仍传入空对象 {}），
  // 若原样透传会出现「实参 1 个、占位符 0 个」的 bind 错误。
  // 同时也兼容 SQL 中已手写 $n（如 reminders 的日期过滤）而没有 ? 的情况。
  const need = countMaxPlaceholder(newSql);
  const values = raw.slice(0, need);
  return { sql: newSql, values };
}

// 统计 SQL 中出现的最大位置参数序号（$1, $2 ... → 返回最大的 n）
function countMaxPlaceholder(sql) {
  let max = 0;
  const re = /\$(\d+)/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

// 函数翻译（占位符已转成 $n 后调用）
function translateFunctions(sql) {
  let s = sql;
  // datetime('now','localtime') → 文本时间戳（与 TEXT 列格式一致，便于字符串比较/展示）
  s = s.replace(/datetime\(\s*'now'\s*,\s*'localtime'\s*\)/gi, "to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')");
  // date('now','localtime','-' || $n || ' days') → 文本日期
  // 必须把参数显式转成 int，否则 Postgres 对 `date - unknown` 无法确定唯一算子而报错。
  s = s.replace(
    /date\(\s*'now'\s*,\s*'localtime'\s*,\s*'-\s*'\s*\|\|\s*(\$\d+)\s*\|\|\s*'\s*days'\s*\)/gi,
    (m, p) => `to_char(CURRENT_DATE - (${p})::int, 'YYYY-MM-DD')`
  );
  return s;
}

// INSERT OR IGNORE（SQLite 方言）→ INSERT ... ON CONFLICT DO NOTHING（Postgres）
// 注意：ON CONFLICT 子句必须位于语句末尾（且在 RETURNING 之前），不能原地替换到表名后面。
function translateIgnore(sql) {
  if (!/INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql)) return sql;
  let s = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO').trim().replace(/;\s*$/, '');
  const ret = s.match(/\s+RETURNING\s+[\s\S]+$/i);
  if (ret) {
    s = s.slice(0, ret.index) + ' ON CONFLICT DO NOTHING' + ret[0];
  } else {
    s += ' ON CONFLICT DO NOTHING';
  }
  return s;
}

// 拥有自增 id 主键的表（settings 表以 key 为主键、无 id 列，不能追加 RETURNING id）
const TABLES_WITH_ID = new Set([
  'tasks', 'documents', 'email_config', 'email_recipients', 'reminders',
  'task_logs', 'task_progress', 'users', 'milestones', 'risks'
]);

// 对 INSERT 语句自动追加 RETURNING id，便于 run() 返回 lastInsertRowid。
// 注意：必须先判断目标表是否真的有 id 列，否则 Postgres 会直接报 column "id" does not exist。
function maybeAddReturning(sql) {
  const t = sql.trim().replace(/\s+/g, ' ');
  if (!/^insert\s+into/i.test(t) || /\breturning\b/i.test(t)) return sql;
  const m = t.match(/^insert\s+into\s+"?([a-zA-Z0-9_]+)"?/i);
  if (!m || !TABLES_WITH_ID.has(m[1].toLowerCase())) return sql;
  return t + ' RETURNING id';
}

function translate(rawSql, args) {
  const ph = translatePlaceholders(rawSql, args);
  let sql = translateFunctions(ph.sql);
  sql = translateIgnore(sql);
  return { sql, values: ph.values };
}

// 执行（统一记录写结果用于诊断）
async function execute(rawSql, args) {
  const { sql, values } = translate(rawSql, args);
  const client = await getPool().connect();
  try {
    const res = await client.query(sql, values);
    _lastWriteOk = true;
    _lastWriteError = null;
    _lastWriteAt = Date.now();
    return res;
  } catch (e) {
    _lastWriteOk = false;
    _lastWriteError = e && e.message ? e.message : String(e);
    console.error('[db] 执行失败:', sql, '| 参数:', JSON.stringify(values), '| 错误:', _lastWriteError);
    throw e;
  } finally {
    client.release();
  }
}

const db = {
  prepare: (sql) => ({
    all: (...args) => execute(sql, args).then((r) => r.rows),
    get: (...args) => execute(sql, args).then((r) => (r.rows && r.rows.length ? r.rows[0] : null)),
    run: (...args) => {
      const sql2 = maybeAddReturning(sql);
      return execute(sql2, args).then((r) => ({
        lastInsertRowid: (r.rows && r.rows.length && r.rows[0].id != null) ? r.rows[0].id : null,
        changes: typeof r.rowCount === 'number' ? r.rowCount : 0
      }));
    }
  }),
  // 供 schema 初始化使用：逐条执行 DDL（按分号拆分，语句内不含分号字面量）
  exec: async (sql) => {
    const client = await getPool().connect();
    try {
      const stmts = sql.split(';').map((s) => s.trim()).filter(Boolean);
      for (const stmt of stmts) {
        await client.query(stmt);
      }
    } finally {
      client.release();
    }
  }
};

// =====================================================================
//  Schema（Postgres DDL，幂等）
// =====================================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
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
  created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT UNIQUE NOT NULL,
  content TEXT DEFAULT '',
  updated_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_by TEXT DEFAULT '系统',
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
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
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  scope TEXT DEFAULT 'all',
  task_ids TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS reminders (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  reminder_date TEXT NOT NULL,
  days_before INTEGER,
  sent INTEGER DEFAULT 0,
  sent_at TEXT,
  created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_logs (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT,
  action TEXT,
  content TEXT,
  operator TEXT DEFAULT '系统',
  created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS task_progress (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL,
  progress INTEGER DEFAULT 0,
  note TEXT,
  recorded_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('admin','user')),
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS milestones (
  id BIGSERIAL PRIMARY KEY,
  node_type TEXT,
  time_node TEXT,
  check_content TEXT,
  deliverable TEXT,
  penalty TEXT,
  created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS risks (
  id BIGSERIAL PRIMARY KEY,
  description TEXT,
  probability TEXT,
  impact TEXT,
  level TEXT,
  measure TEXT,
  owner TEXT,
  trigger TEXT,
  created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
);
`;

// =====================================================================
//  初始化
// =====================================================================

async function ensureSchema() {
  if (_schemaReady) return;
  await db.exec(SCHEMA);
  _schemaReady = true;
  console.log('[存储] Supabase Postgres 表结构已就绪（11 张表）');
}

async function initDefaultAdmin() {
  const admin = await db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
      .run('admin', hash, '系统管理员', 'admin');
    console.log('[用户] 默认超管账号已创建: admin / admin123');
  }
}

let _readyPromise = null;
async function init() {
  if (_readyPromise) return _readyPromise;
  _readyPromise = (async () => {
    if (!POOL_CONFIGURED) {
      console.warn('[存储] ⚠️ SUPABASE_DB_URL 未配置：数据无法持久化。请在 Vercel 环境变量配置 Supabase Postgres 连接串。');
      return;
    }
    // 连接探活
    try {
      await getPool().query('SELECT 1');
    } catch (e) {
      console.error('[存储] ⚠️ 无法连接 Supabase Postgres:', e && e.message);
      throw e;
    }
    await ensureSchema();
    await initDefaultAdmin();
    console.log('[存储] Supabase Postgres 已连接，数据将持久化到 Supabase。');
  })();
  return _readyPromise;
}

function ensureReady() {
  return init();
}

// =====================================================================
//  邮件配置
// =====================================================================

async function getEmailConfig() {
  const row = await db.prepare('SELECT * FROM email_config WHERE id = 1').get();
  if (!row) {
    await db.prepare('INSERT INTO email_config (id) VALUES (1)').run();
    return { id: 1, smtp_host: '', smtp_port: 465, smtp_user: '', smtp_pass: '', smtp_secure: 1, sender_name: '闻道任务提醒', enabled: 0 };
  }
  return row;
}

async function upsertEmailConfig(cfg) {
  await db.prepare(`
    INSERT INTO email_config (id, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, sender_name, enabled)
    VALUES (1, @smtp_host, @smtp_port, @smtp_user, @smtp_pass, @smtp_secure, @sender_name, @enabled)
    ON CONFLICT(id) DO UPDATE SET
      smtp_host=@smtp_host, smtp_port=@smtp_port, smtp_user=@smtp_user,
      smtp_pass=@smtp_pass, smtp_secure=@smtp_secure, sender_name=@sender_name, enabled=@enabled
  `).run(cfg);
}

// =====================================================================
//  用户管理
// =====================================================================

async function initDefaultAdminExport() { return initDefaultAdmin(); }

async function getUserById(id) {
  return db.prepare('SELECT id, username, display_name, role, enabled, created_at FROM users WHERE id = ?').get(id);
}

async function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

async function listUsers() {
  return db.prepare('SELECT id, username, display_name, role, enabled, created_at, updated_at FROM users ORDER BY id ASC').all();
}

async function createUser(username, passwordHash, displayName, role) {
  return db.prepare('INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, displayName || username, role || 'user');
}

async function updateUser(id, fields) {
  const sets = [];
  const params = {};
  if (fields.display_name !== undefined) { sets.push('display_name = @display_name'); params.display_name = fields.display_name; }
  if (fields.role !== undefined) { sets.push('role = @role'); params.role = fields.role; }
  if (fields.enabled !== undefined) { sets.push('enabled = @enabled'); params.enabled = fields.enabled ? 1 : 0; }
  if (fields.password_hash !== undefined) { sets.push('password_hash = @password_hash'); params.password_hash = fields.password_hash; }
  sets.push("updated_at = to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')");
  params.id = id;
  return db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

async function deleteUser(id) {
  return db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

// =====================================================================
//  提醒设置（页面可配置的定时发送时间 / 提前提醒天数）
// =====================================================================

async function getSetting(key, def) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : def;
  } catch (e) { return def; }
}

async function setSetting(key, value) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, String(value), String(value));
}

async function getReminderSettings() {
  const enabled = (await getSetting('reminder_enabled', '0')) === '1';
  let hour = parseInt(await getSetting('reminder_hour', '20'), 10);
  if (isNaN(hour) || hour < 0 || hour > 23) hour = 20;
  let minute = parseInt(await getSetting('reminder_minute', '0'), 10);
  if (isNaN(minute) || minute < 0 || minute > 59) minute = 0;
  let leadDays;
  try { leadDays = JSON.parse(await getSetting('reminder_lead_days', '[1,3,7]')); } catch (e) { leadDays = [1, 3, 7]; }
  if (!Array.isArray(leadDays) || leadDays.length === 0) leadDays = [1, 3, 7];
  leadDays = leadDays.map(Number).filter(n => Number.isFinite(n) && n >= 0);
  if (leadDays.length === 0) leadDays = [1, 3, 7];
  return { enabled, hour, minute, leadDays };
}

async function setReminderSettings(s) {
  if (!s || typeof s !== 'object') return;
  await setSetting('reminder_enabled', s.enabled ? '1' : '0');
  await setSetting('reminder_hour', String(Number.isFinite(s.hour) ? s.hour : 20));
  await setSetting('reminder_minute', String(Number.isFinite(s.minute) ? s.minute : 0));
  const days = Array.isArray(s.leadDays) && s.leadDays.length
    ? s.leadDays.map(Number).filter(n => Number.isFinite(n) && n >= 0)
    : [1, 3, 7];
  await setSetting('reminder_lead_days', JSON.stringify(days.length ? days : [1, 3, 7]));
}

// =====================================================================
//  存储状态诊断（供 /api/storage/status 与设置页展示）
// =====================================================================

async function getStorageStatus() {
  let counts = null;
  try {
    const r = await getPool().query(
      'SELECT (SELECT COUNT(*) FROM tasks) AS tasks, ' +
      '(SELECT COUNT(*) FROM users) AS users, ' +
      '(SELECT COUNT(*) FROM email_recipients) AS recipients'
    );
    counts = r.rows[0];
  } catch (e) { /* ignore */ }

  const urlConfigured = POOL_CONFIGURED;
  let connected = false;
  let connectError = null;
  if (urlConfigured) {
    try {
      await getPool().query('SELECT 1');
      connected = true;
    } catch (e) {
      connected = false;
      connectError = e && e.message ? e.message : String(e);
    }
  }
  return {
    postgres: {
      urlConfigured,
      connected,
      connectError,
      lastSaveOk: _lastWriteOk,
      lastSaveError: _lastWriteError,
      lastSaveAt: _lastWriteAt ? new Date(_lastWriteAt).toISOString() : null
    },
    loadSource: 'postgres',
    counts
  };
}

// 最近一次写结果（供写接口在响应中注入 persistWarning，统一暴露持久化失败）
function getLastSave() {
  // 即便未配置连接串，只要确实发生过写且未成功，也应判定为失败并告警。
  const ok = POOL_CONFIGURED && _lastWriteOk !== false;
  return {
    configured: POOL_CONFIGURED,
    ok,
    error: _lastWriteError || (!POOL_CONFIGURED ? 'SUPABASE_DB_URL 未配置到运行时：数据无法持久化。' : null),
    at: _lastWriteAt ? new Date(_lastWriteAt).toISOString() : null
  };
}

module.exports = {
  db,
  getEmailConfig,
  getLastSave,
  upsertEmailConfig,
  getSetting,
  setSetting,
  getReminderSettings,
  setReminderSettings,
  getStorageStatus,
  initDefaultAdmin: initDefaultAdminExport,
  getUserById,
  getUserByUsername,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  init,
  ensureReady
};

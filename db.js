/**
 * db.js — 双驱动公共数据库抽象层（Supabase Postgres / 本地 SQLite 兜底）
 *
 * ── 设计目标 ──
 *   - 对外只暴露一套统一接口：db.prepare(sql).all/get/run 与 db.exec(...)，
 *     调用方（server.js / excel-reader.js / scheduler.js / email.js）零改动即可切换底层数据库。
 *   - 两种驱动：
 *      ① Supabase 驱动：经 @supabase/supabase-js（HTTPS 443）调用 Supabase 上的
 *         exec_sql RPC（见 scripts/exec_sql.sql），绕开 db.*.supabase.co 直连主机无法公网解析的问题，
 *         且天然多实例共享同一数据源，根治「多实例内存库互相覆盖 / 重部署假丢失」顽疾。
 *      ② SQLite 驱动：sql.js（浏览器/Node 可用的 WASM SQLite），作为【离线模式】。
 *         仅当「未配置 Supabase」或「显式设置 FREEDOM_OFFLINE=1」时使用；
 *         Postgres 已配置但连接失败时【不再静默降级】，而是明确报错，需手动开启离线开关。
 *   - 方言策略：业务代码统一写 SQLite 风格 SQL；Supabase 模式下由「翻译层」转成 Postgres；
 *     SQLite 模式直接原生执行。这样同一份 SQL 在两种数据库都能跑。
 *
 * ── 环境变量 ──
 *   SUPABASE_URL              —— 项目地址，形如 https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY —— 服务角色密钥（Settings → API → service_role），拥有建表/读写全表权限（推荐）
 *   SUPABASE_ANON_KEY         —— 匿名密钥（用户最初提供）；后端仅在无 service_role 时回退使用，
 *                                exec_sql 已授权 anon，但密钥仅应留在服务端，切勿下发到前端。
 *   FREEDOM_OFFLINE=1         —— 显式离线开关；设置后强制使用本地 SQLite（云平台到期后的离线运行方式），
 *                                即使已配置 Supabase 也会忽略云端、改用本地库，绝不连接网络。
 *   未配置 SUPABASE_* 且未设 FREEDOM_OFFLINE → 自动使用本地 SQLite（本地开发/单机部署）。
 *   已配置 SUPABASE_* 但连接失败 → 明确报错，不再静默降级；需离线时设 FREEDOM_OFFLINE=1 重启。
 */

const { createClient } = require('@supabase/supabase-js');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// 固定版 exec_sql 函数本体（与 scripts/exec_sql.sql 同步，供自愈重装使用）。
// 仅在数据库里是旧版有 bug 的实现、且用（可能已坏的）exec_sql 以【空参数】重装时才用到。
const EXEC_SQL_DEFINITION = require('./api/exec-sql-def');

// ===================== 驱动选择 =====================
// 注意 trim：从 GitHub/Vercel 面板复制粘贴极易带入首尾空白或换行，
// 不清理会导致 createClient 抛 "Invalid URL" 或鉴权 401，且现象很难排查。
const envStr = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
};
const SUPABASE_URL = envStr('SUPABASE_URL');
const SUPABASE_KEY = envStr('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_KEY');
const SUPABASE_CONFIGURED = !!(SUPABASE_URL && SUPABASE_KEY);
// 显式离线开关：设置后强制使用本地 SQLite，云平台（Supabase）到期后以此方式离线运行。
// 即使已配置 Supabase，开启此开关也会忽略云端、改用本地库，绝不连接网络。
const FREEDOM_OFFLINE = !!envStr('FREEDOM_OFFLINE');

let DRIVER = null;            // 'supabase' | 'sqlite'（init 后确定）
let _supabaseError = null;    // supabase 连接/exec_sql 失败原因（配置存在但连不上时记录）
let _sqliteError = null;      // SQLite 初始化失败原因（如 wasm 未打包）

// ===================== Supabase 客户端（懒加载）=====================
let _sb = null;
function getSupabase() {
  if (!_sb) {
    if (!SUPABASE_CONFIGURED) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置：数据无法持久化。' +
        '请在 Vercel / GitHub Actions 变量中配置 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY（或 SUPABASE_ANON_KEY）。');
    }
    _sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _sb;
}

// ===================== SQLite（sql.js 懒加载）=====================
let _sqliteDb = null;
let _sqlJsInit = null;
let _sqliteEngine = null;   // 'wasm' | 'asm'（诊断用）

/**
 * 加载 sql.js 引擎。
 *
 * 坑：sql.js 默认入口 dist/sql-wasm.js 会在运行时用 __dirname 拼出 sql-wasm.wasm 再 fs 读取。
 * 这是「动态文件依赖」，Vercel 的依赖追踪（NFT）扫不到，导致 .wasm 不会被打进函数包，
 * 线上报 ENOENT: /var/task/node_modules/sql.js/dist/sql-wasm.wasm。
 *
 * 策略：先显式定位 .wasm；文件确实存在才用 wasm 版；否则回退到 dist/sql-asm.js
 * （纯 JS 的 asm.js 构建，无任何外部二进制依赖，Serverless 下必定可用，仅稍慢）。
 */
function loadSqlJsEngine() {
  try {
    const distDir = path.dirname(require.resolve('sql.js'));   // → node_modules/sql.js/dist
    const wasmPath = path.join(distDir, 'sql-wasm.wasm');
    if (fs.existsSync(wasmPath)) {
      _sqliteEngine = 'wasm';
      return initSqlJs({ locateFile: () => wasmPath });
    }
    console.warn('[db] sql-wasm.wasm 未随函数包一起部署，回退 asm.js 构建:', wasmPath);
  } catch (e) {
    console.warn('[db] 定位 sql-wasm.wasm 失败，回退 asm.js 构建:', e && e.message);
  }
  // 回退：纯 JS 实现（静态 require，NFT 可追踪，必定被打包）
  const initSqlJsAsm = require('sql.js/dist/sql-asm.js');
  _sqliteEngine = 'asm';
  return initSqlJsAsm();
}

async function getSqlite() {
  if (!_sqliteDb) {
    if (!_sqlJsInit) _sqlJsInit = loadSqlJsEngine();
    const SQL = await _sqlJsInit;
    _sqliteDb = new SQL.Database();
    _sqliteDb.run('PRAGMA foreign_keys = ON');
  }
  return _sqliteDb;
}

function activeDriver() {
  if (DRIVER) return DRIVER;
  // 离线开关优先：显式声明用本地库，绝不去连 Supabase
  if (FREEDOM_OFFLINE) return 'sqlite';
  return SUPABASE_CONFIGURED ? 'supabase' : 'sqlite';
}

// ===================== 持久化状态（用于运行态诊断）=====================
let _lastWriteOk = null;     // 最近一次写是否成功（null=尚无写入）
let _lastWriteError = null;
let _lastWriteAt = 0;
// 按驱动分别记忆建表状态（不能用单个布尔量，原因见 ensureSchema 注释）
let _schemaReadyFor = null;   // null | 'supabase' | 'sqlite'

// =====================================================================
//  SQL 翻译层：SQLite 风格 → Postgres（仅 Supabase 模式使用）
// =====================================================================

// 占位符：?（位置参数）与 @name（命名参数）统一转为 $1, $2, ...
// 返回 { sql, values }
function translatePlaceholders(sql, args) {
  const hasNamed = /@([a-zA-Z0-9_]+)/.test(sql);
  if (hasNamed) {
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
  let idx = 0;
  const newSql = sql.replace(/\?/g, () => {
    idx++;
    return '$' + idx;
  });
  const raw = (args.length === 1 && Array.isArray(args[0])) ? args[0] : Array.from(args);
  const need = countMaxPlaceholder(newSql);
  const values = raw.slice(0, need);
  return { sql: newSql, values };
}

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

function translateFunctions(sql) {
  let s = sql;
  s = s.replace(/datetime\(\s*'now'\s*,\s*'localtime'\s*\)/gi, "to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')");
  s = s.replace(
    /date\(\s*'now'\s*,\s*'localtime'\s*,\s*'-\s*'\s*\|\|\s*(\$\d+)\s*\|\|\s*'\s*days'\s*\)/gi,
    (m, p) => `to_char(CURRENT_DATE - (${p})::int, 'YYYY-MM-DD')`
  );
  return s;
}

// INSERT OR IGNORE（SQLite 方言）→ INSERT ... ON CONFLICT DO NOTHING（Postgres）
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

// SQLite 命名参数绑定修正：sql.js 需要带前缀的键（@name）
function resolveBindSqlite(args) {
  let a = args;
  if (args.length === 1 && Array.isArray(args[0])) a = args[0];
  if (a.length === 1 && a[0] && typeof a[0] === 'object' && !Array.isArray(a[0])) {
    const obj = {};
    for (const k of Object.keys(a[0])) obj['@' + k] = a[0][k];
    return obj;
  }
  return a;
}

// =====================================================================
//  统一执行接口（根据当前驱动路由）
// =====================================================================
async function execPrepare(rawSql, args, mode) {
  const driver = activeDriver();
  if (driver === 'supabase') {
    const { sql, values } = translate(rawSql, args);
    let sql2 = sql;
    if (mode === 'run') sql2 = maybeAddReturning(sql);
    // 关键修复：exec_sql RPC 以 "SELECT %" 前缀判定是否把结果聚合成 JSON 行集；
    // 业务代码里大量使用「换行+缩进」开头的多行模板字符串（如 `\n  SELECT ...`），
    // 会让 upper_sql 以空白字符开头，导致 LIKE 'SELECT %' 失配、落入 ELSE 分支
    // 返回 { rowCount } 对象而非数组 → db.prepare(...).all() 拿到空数组 → 任务/提醒全部落空。
    // 统一在这里 trim，无论调用方怎么排版，结果集查询都能被正确识别。（exec_sql.sql 中也加了 ltrim 兜底）
    sql2 = sql2.trim();
    try {
      const { data, error } = await getSupabase().rpc('exec_sql', { sql: sql2, params: values });
      if (error) throw new Error((error && error.message) || JSON.stringify(error));
      _lastWriteOk = true;
      _lastWriteError = null;
      _lastWriteAt = Date.now();
      if (mode === 'all') return Array.isArray(data) ? data : [];
      if (mode === 'get') return (Array.isArray(data) && data.length) ? data[0] : null;
      // run
      if (Array.isArray(data)) {
        return {
          lastInsertRowid: (data[0] && data[0].id != null) ? Number(data[0].id) : null,
          changes: data.length
        };
      }
      return {
        lastInsertRowid: null,
        changes: (data && typeof data.rowCount === 'number') ? data.rowCount : 0
      };
    } catch (e) {
      _lastWriteOk = false;
      _lastWriteError = e && e.message ? e.message : String(e);
      console.error('[db] 执行失败:', sql2, '| 参数:', JSON.stringify(values), '| 错误:', _lastWriteError);
      throw e;
    }
  }

  // ---- SQLite 驱动 ----
  // 注意：sql.js 的 Database 仅提供 run()/exec()，Statement 提供 get()/run() 但【没有 all()】；
  // 关键坑：stmt.get() 返回的是【值数组】，而非列名→值的对象，也不提供 .all()。
  // 因此必须配合 stmt.getColumnNames() 把数组映射成对象，才能与 Supabase 路径（返回列名对象）一致，
  // 否则上层 user.enabled 等字段会变成 undefined（导致「账号已被禁用」）。
  const sqlite = await getSqlite();
  const stmt = sqlite.prepare(rawSql);
  const bind = resolveBindSqlite(args);
  try {
    if (Array.isArray(bind) ? bind.length : (bind && typeof bind === 'object')) {
      stmt.bind(bind);
    }
    _lastWriteOk = true;
    _lastWriteError = null;
    _lastWriteAt = Date.now();
    if (mode === 'all') {
      const cols = stmt.getColumnNames();
      const rows = [];
      while (stmt.step()) {
        const vals = stmt.get();
        const obj = {};
        cols.forEach((c, i) => { obj[c] = vals[i]; });
        rows.push(obj);
      }
      return rows;
    }
    if (mode === 'get') {
      if (!stmt.step()) return null;
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      const obj = {};
      cols.forEach((c, i) => { obj[c] = vals[i]; });
      return obj;
    }
    // run（INSERT/UPDATE/DELETE）
    stmt.run();
    const changes = sqlite.getRowsModified();
    let lastInsertRowid = null;
    if (/^\s*insert/i.test(rawSql)) {
      const li = sqlite.exec('SELECT last_insert_rowid() AS id');
      if (li.length && li[0].values.length) lastInsertRowid = li[0].values[0][0];
    }
    return { lastInsertRowid, changes };
  } catch (e) {
    _lastWriteOk = false;
    _lastWriteError = e && e.message ? e.message : String(e);
    console.error('[db] SQLite 执行失败:', rawSql, '| 错误:', _lastWriteError);
    throw e;
  } finally {
    if (stmt && typeof stmt.free === 'function') stmt.free();
  }
}

const db = {
  prepare: (sql) => ({
    all: (...args) => execPrepare(sql, args, 'all'),
    get: (...args) => execPrepare(sql, args, 'get'),
    run: (...args) => execPrepare(sql, args, 'run')
  }),
  // DDL / 批量：Supabase 按分号拆分逐条 rpc；SQLite 直接一次性执行（支持多语句）
  exec: async (sql) => {
    if (activeDriver() === 'supabase') {
      const stmts = sql.split(';').map((s) => s.trim()).filter(Boolean);
      for (const stmt of stmts) {
        const { error } = await getSupabase().rpc('exec_sql', { sql: stmt, params: [] });
        if (error) throw new Error((error && error.message) || JSON.stringify(error));
      }
    } else {
      const s = await getSqlite();
      // sql.js 的 Database.run 只执行单条语句；建表脚本含多条 CREATE，必须用 exec
      s.exec(sql);
    }
  }
};

// =====================================================================
//  Schema（双份：Postgres / SQLite，均为幂等 DDL）
// =====================================================================

const SCHEMA_POSTGRES = `
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

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  log_type TEXT NOT NULL DEFAULT 'user',
  category TEXT,
  action TEXT,
  target_type TEXT,
  target_id TEXT,
  summary TEXT,
  detail TEXT,
  status TEXT DEFAULT 'success',
  operator TEXT DEFAULT '系统',
  operator_id BIGINT,
  operator_role TEXT,
  ip TEXT,
  user_agent TEXT,
  method TEXT,
  path TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  created_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_log_type ON audit_logs(log_type);

CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs(category);
`;

const SCHEMA_SQLITE = `
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
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
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
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT DEFAULT 'user' CHECK (role IN ('admin','user')),
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_type TEXT,
  time_node TEXT,
  check_content TEXT,
  deliverable TEXT,
  penalty TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS risks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  description TEXT,
  probability TEXT,
  impact TEXT,
  level TEXT,
  measure TEXT,
  owner TEXT,
  trigger TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_type TEXT NOT NULL DEFAULT 'user',
  category TEXT,
  action TEXT,
  target_type TEXT,
  target_id TEXT,
  summary TEXT,
  detail TEXT,
  status TEXT DEFAULT 'success',
  operator TEXT DEFAULT '系统',
  operator_id INTEGER,
  operator_role TEXT,
  ip TEXT,
  user_agent TEXT,
  method TEXT,
  path TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_log_type ON audit_logs(log_type);

CREATE INDEX IF NOT EXISTS idx_audit_logs_category ON audit_logs(category);
`;

// =====================================================================
//  初始化
// =====================================================================

async function ensureSchema() {
  const drv = activeDriver();
  // 【关键】必须按驱动记忆，不能用一个布尔量。
  // 降级路径是：Supabase 探活通过 → 建表成功（标记已就绪）→ 后续步骤失败 → 降级 SQLite。
  // 此时若沿用布尔量，SQLite 分支会被直接 return 跳过，兜底库里一张表都没有，
  // 表现为 "no such table: users"，且比原始故障更难定位。
  if (_schemaReadyFor === drv) return;
  if (drv === 'supabase') {
    await db.exec(SCHEMA_POSTGRES);
  } else {
    const s = await getSqlite();
    // 必须走 exec（支持多条 CREATE 语句），Database.run 只执行单条
    s.exec(SCHEMA_SQLITE);
  }
  _schemaReadyFor = drv;
  console.log('[存储] 表结构已就绪（12 张表，驱动: ' + drv + '）');
}

// =====================================================================
//  内置种子数据
// =====================================================================

/**
 * api/embedded-seed.js 是一份 base64 编码的 SQLite 快照，内含项目初始业务数据
 * （21 个任务、21 份文档、12 个里程碑、10 项风险、2 个用户等）。
 *
 * 坑：旧版实现是「把这份快照直接当数据库文件打开」（new SQL.Database(bytes)），
 * 所以迁移到 Supabase 原生表之后，这段加载逻辑被整体删掉了，新库空空如也——
 * 线上表现就是「能登录，但任务数据全没了」。
 *
 * 这里改为「按行读出 → 经统一 db.prepare 接口写回」，从而同时适用于两种驱动：
 *   - Supabase：首次初始化灌入，之后靠 settings 标记跳过；
 *   - SQLite 兜底：每次冷启动都是全新空库，必须重新灌入才能看到内置数据。
 */
const SEED_TABLES = [
  'tasks',              // 必须最先：documents/reminders/task_progress 外键指向 tasks(task_id)
  'documents', 'reminders', 'task_progress', 'task_logs',
  'milestones', 'risks', 'email_config', 'email_recipients', 'users'
];

function readSeedRows(seedDb, table) {
  let stmt;
  try {
    stmt = seedDb.prepare('SELECT * FROM ' + table);
  } catch (e) {
    return { cols: [], rows: [] };   // 种子快照里没有这张表（后来新增的），跳过即可
  }
  const cols = stmt.getColumnNames();
  const rows = [];
  while (stmt.step()) rows.push(stmt.get());
  stmt.free();
  return { cols, rows };
}

async function markSeedImported() {
  await db.prepare(
    "INSERT INTO settings (key, value) VALUES ('seed_imported', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
  ).run();
}

async function importEmbeddedSeed() {
  // 显式关闭开关：自动化测试需要确定性的空库；
  // 若部署方不想要内置演示数据，也可置 FREEDOM_SKIP_SEED=1 得到纯净库。
  if (envStr('FREEDOM_SKIP_SEED')) return;

  // 幂等只认标记，不能只看「表是不是空的」——
  // 否则用户主动清空全部任务后，下次冷启动会被「好心」还原，属于数据事故。
  const mark = await db.prepare("SELECT value FROM settings WHERE key = ?").get('seed_imported');
  if (mark && mark.value) return;

  // 已有业务数据的老库（本次改动之前就建好的）：只补标记，绝不灌数据
  const cnt = await db.prepare('SELECT COUNT(*) AS c FROM tasks').get();
  if (cnt && Number(cnt.c) > 0) { await markSeedImported(); return; }

  let b64;
  try {
    b64 = require('./api/embedded-seed');
  } catch (e) {
    console.warn('[种子] 未找到 api/embedded-seed.js，跳过内置数据导入');
    return;
  }
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length) return;

  if (!_sqlJsInit) _sqlJsInit = loadSqlJsEngine();
  const SQL = await _sqlJsInit;
  const seedDb = new SQL.Database(bytes);

  let total = 0;
  try {
    for (const table of SEED_TABLES) {
      const { cols, rows } = readSeedRows(seedDb, table);
      if (!rows.length) continue;

      // email_config 主键被 CHECK (id = 1) 锁死，必须带 id；
      // 其余表一律丢弃 id 交给数据库自增——外键都走 task_id(TEXT) 而非数字 id，
      // 不带 id 反而免去 Postgres 的 BIGSERIAL 序列不同步、后续插入撞主键的问题。
      const useCols = table === 'email_config' ? cols : cols.filter(c => c !== 'id');
      const idx = useCols.map(c => cols.indexOf(c));

      // 必须批量插入：Supabase 每条 SQL 都是一次 HTTPS 往返，
      // 逐行插 60+ 行会让冷启动多花十几秒，有超时风险。
      const CHUNK = 50;
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const tuple = '(' + useCols.map(() => '?').join(', ') + ')';
        const sql = 'INSERT OR IGNORE INTO ' + table + ' (' + useCols.join(', ') + ') VALUES '
                  + chunk.map(() => tuple).join(', ');
        const values = [];
        for (const row of chunk) for (const j of idx) values.push(row[j]);
        try {
          await db.prepare(sql).run(...values);
          total += chunk.length;
        } catch (e) {
          console.warn('[种子] ' + table + ' 批量导入失败（已跳过该批）:', e && e.message);
        }
      }
    }
    await markSeedImported();
    console.log('[种子] 内置数据已导入 ' + total + ' 行（驱动: ' + activeDriver() + '）');
  } finally {
    try { seedDb.close(); } catch (e) { /* 忽略 */ }
  }
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

/**
 * 探测 Supabase 上部署的 exec_sql 是不是【旧版有 bug 的实现】。
 *
 * 背景（真实线上事故）：旧实现按参数倒序做全局 regexp_replace 替换 $n，
 * 一旦某个参数值内部含有 "$数字"（bcrypt 哈希 $2b$10$... 就是典型），
 * 它会在后续轮次里被当成占位符二次替换，把 SQL 撕碎。
 * 现象是 `syntax error at or near "admin"` —— 完全看不出「函数是旧版、需要重新执行 SQL」，
 * 这正是上次排查耗时最久的地方。
 *
 * 该函数存在于数据库而非代码里，推代码不会更新它，因此必须主动探测并给出明确指引。
 *
 * 探针：SELECT $1, $2，参数 ['X', '$1']。
 *   修复版（单趟从左到右扫描）→ 第二列原样返回 '$1'；
 *   旧版          → 第二列的 '$1' 会被第 1 轮替换命中，报错或返回错值。
 */
async function assertExecSqlNotStale() {
  const HINT = 'Supabase 上的 exec_sql 是【旧版有 bug 的实现】：参数值内部含 "$数字"（如 bcrypt 哈希 $2b$10$...）时会被二次替换，'
             + '导致 SQL 被撕碎、报出 syntax error at or near "..." 之类的怪错。'
             + '请在 Supabase 控制台 SQL Editor 【重新完整执行一次】 scripts/exec_sql.sql（含末尾的 NOTIFY pgrst）。'
             + '注意该函数存在于数据库中，重新部署代码不会更新它。';
  let rows;
  try {
    const { data, error } = await getSupabase().rpc('exec_sql', {
      sql: 'SELECT $1::text AS a, $2::text AS b', params: ['X', '$1']
    });
    if (error) throw new Error((error && error.message) || JSON.stringify(error));
    rows = data;
  } catch (e) {
    throw new Error(HINT + '（探测时的原始报错：' + (e && e.message ? e.message : String(e)) + '）');
  }
  const r = Array.isArray(rows) && rows[0];
  if (!r || r.a !== 'X' || r.b !== '$1') {
    throw new Error(HINT + '（探测返回：' + JSON.stringify(r) + '）');
  }
}

/**
 * 自愈：用（可能已损坏的）exec_sql 以【空参数】重新安装正确的函数本体。
 *
 * 为什么空参数能绕过旧版 bug：旧实现只在「参数值内部含 $数字」时把 SQL 撕碎；
 * 这里传 params: []，函数内部没有任何字面量可注入，扫描到函数本体里的 $1/$2 时
 * 因 lits 为空而原样保留，于是 CREATE OR REPLACE FUNCTION 被【逐字】执行，
 * 把坏函数覆盖成修复版。函数本身是 SECURITY DEFINER（以库 owner 运行），
 * 因此即便只配了 anon 密钥，也能借它获得建/改函数的权限。
 *
 * 调用方（init）在探活通过、但 exec_sql 版本探针失败时调用本函数，再重新探测；
 * 若重装成功，则后续全部走 Supabase。失败则正常降级 SQLite（不改变既有行为）。
 */
let _healAttempted = false;
async function reinstallExecSql() {
  // 仅CREATE块（含 $$ 正文），末尾的分号由 exec_sql 的 rtrim 处理；
  // 不在这里发 NOTIFY——函数本体被替换后立即对新调用生效，schema 缓存无需刷新。
  const { error } = await getSupabase().rpc('exec_sql', {
    sql: EXEC_SQL_DEFINITION,
    params: []
  });
  if (error) throw new Error((error && error.message) || JSON.stringify(error));
  _healAttempted = true;
}

let _readyPromise = null;
async function init() {
  if (_readyPromise) return _readyPromise;
  _readyPromise = (async () => {
    // ── 模式一：显式离线开关（FREEDOM_OFFLINE=1）──
    // 云平台（Supabase）到期后以此方式离线运行：强制本地 SQLite，绝不连接网络。
    if (FREEDOM_OFFLINE) {
      console.log('[存储] 离线模式（FREEDOM_OFFLINE=1）：使用本地 SQLite，忽略 Supabase 配置');
      DRIVER = 'sqlite';
      try {
        await ensureSchema();
        await ensureDefaultReminderSettings();
        try { await importEmbeddedSeed(); }
        catch (e) { console.warn('[种子] 导入内置数据失败（不影响服务）:', e && e.message); }
        await initDefaultAdmin();
        console.log('[存储] 离线模式已就绪（本地 SQLite，数据仅进程内）');
      } catch (e) {
        _sqliteError = e && e.message ? e.message : String(e);
        console.error('[存储] ✗ 离线 SQLite 初始化失败:', _sqliteError);
      }
      return;
    }

    // ── 模式二：已配置 Supabase → 只用 Postgres ──
    if (SUPABASE_CONFIGURED) {
      try {
        const { data: d2, error: e2 } = await getSupabase().rpc('exec_sql', { sql: 'SELECT 1', params: [] });
        if (e2) throw new Error((e2 && e2.message) || JSON.stringify(e2));
        if (!Array.isArray(d2) || d2.length === 0) throw new Error('exec_sql 返回空，连接可能异常');
        try {
          await assertExecSqlNotStale();
        } catch (staleErr) {
          // 探测到旧版有 bug 的 exec_sql：尝试用（可能已坏的）exec_sql 空参数重装正确本体自愈，
          // 成功则继续走 Supabase；失败则按需求「只用 Postgres」判定存储不可用（不再降级 SQLite）。
          if (!_healAttempted) {
            try {
              await reinstallExecSql();
              await assertExecSqlNotStale();   // 重装后必须重新探测确认
              console.log('[存储] ✅ 已自动重装 exec_sql 函数（修复旧版 $数字 二次替换 bug），继续走 Supabase');
            } catch (healErr) {
              console.error('[存储] ⚠️ 自动重装 exec_sql 失败:', (healErr && healErr.message) || healErr);
              throw staleErr;
            }
          } else {
            throw staleErr;
          }
        }
        DRIVER = 'supabase';
        await ensureSchema();
        await ensureDefaultReminderSettings();
        // 种子导入放在建管理员之前：种子里自带 admin（密码同为 admin123）与其它用户，
        // 先导入可保留原始账号信息，initDefaultAdmin 届时发现 admin 已存在会自动跳过。
        try { await importEmbeddedSeed(); }
        catch (e) { console.warn('[种子] 导入内置数据失败（不影响服务）:', e && e.message); }
        await initDefaultAdmin();
        console.log('[存储] 已连接 Supabase（Postgres，via exec_sql RPC）');
        return;
      } catch (e) {
        let msg = e && e.message ? e.message : String(e);
        // 把「函数不存在」这类底层报错翻译成可操作的指引：
        // 变量都配对了但没建 RPC 是最常见的部署遗漏，原始报错完全看不出该做什么。
        if (/schema cache|could not find the function|function .*exec_sql.* does not exist/i.test(msg)) {
          msg = 'Supabase 尚未创建 exec_sql 函数（' + msg + '）。'
              + '请在 Supabase 控制台 SQL Editor 执行一次 scripts/exec_sql.sql，'
              + '其中末尾的 NOTIFY pgrst 用于刷新 PostgREST schema 缓存，务必一并执行。';
        } else if (/Invalid API key|JWT|401|apikey/i.test(msg)) {
          msg = 'Supabase 密钥无效或已轮换（' + msg + '）。'
              + '请核对 SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 与 SUPABASE_URL 是否属于同一个项目。';
        }
        // 严格「只用 Postgres」：配置存在但连不上时【不再静默降级 SQLite】，
        // 明确记录失败原因，由 storageFailure() 向用户报清晰错误。
        // 需要离线运行时，请设置 FREEDOM_OFFLINE=1 重启进入离线模式。
        console.error('[存储] ✗ Supabase(Postgres) 连接/初始化失败，未启用离线兜底（如需离线请设 FREEDOM_OFFLINE=1）:', msg);
        _supabaseError = msg;
        return;
      }
    }

    // ── 模式三：未配置 Supabase 且非离线模式 → 本地 SQLite（本地开发/单机部署）──
    // 注意：这里【绝不允许抛异常】。init() 由 api/index.js 在每个请求前 await，
    // 一旦抛出会让所有接口（含 /api/health）都变成 500，反而看不到真正的失败原因。
    DRIVER = 'sqlite';
    try {
      await ensureSchema();
      await ensureDefaultReminderSettings();
      // 兜底库每次冷启动都是空的，必须重新灌入内置数据，否则用户登录进去一片空白
      try { await importEmbeddedSeed(); }
      catch (e) { console.warn('[种子] 导入内置数据失败（不影响服务）:', e && e.message); }
      await initDefaultAdmin();
      console.log('[存储] 使用本地 SQLite（未配置 Supabase，离线/本地模式，数据仅进程内）');
    } catch (e) {
      _sqliteError = e && e.message ? e.message : String(e);
      console.error('[存储] ✗ SQLite 初始化失败:', _sqliteError);
      // 不 rethrow：让 /api/health 等诊断接口仍可用，业务接口再按 storageFailure() 报清晰错误
    }
  })();
  return _readyPromise;
}

/**
 * 当前存储是否完全不可用；可用时返回 null，不可用时返回给用户看的清晰原因。
 * 用于替代「sql.js wasm ENOENT」这类会误导人的底层报错。
 */
function storageFailure() {
  // 离线模式或未配置 Supabase：仅当本地 SQLite 自身起不来才算存储不可用
  if (FREEDOM_OFFLINE || !SUPABASE_CONFIGURED) {
    if (_sqliteError) {
      return '数据库不可用（离线/本地模式 SQLite 初始化失败）：' + _sqliteError;
    }
    return null;
  }
  // 已配置 Supabase：「只用 Postgres」——配置存在但连不上即判定存储不可用，绝不静默回退
  if (_supabaseError) {
    return '数据库不可用。已配置 Supabase(Postgres) 但连接/初始化失败：' + _supabaseError +
      '。本系统已设为「仅用 Postgres」，不会静默降级到易丢数据的 SQLite。' +
      '如需离线运行，请设置环境变量 FREEDOM_OFFLINE=1 并重启（将改用本地 SQLite）。';
  }
  if (_sqliteError) {
    return '数据库不可用：本地 SQLite 兜底初始化失败：' + _sqliteError;
  }
  return null;
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
  sets.push("updated_at = datetime('now','localtime')");
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

// 初始化时把「提醒设置」的默认配置写入 settings 表。
// 关键：仅当对应 key 不存在时才插入，绝不覆盖用户在页面保存过的配置。
// 作用：即使从未在页面点过「保存」，数据库里也始终存在 reminder_enabled /
// reminder_hour / reminder_minute / reminder_lead_days 等记录，配置可审计、
// 可直接查证是否落库（解决「提前提醒天数配置没有落到数据库中」的排查困惑）。
const DEFAULT_REMINDER_SETTINGS = [
  ['reminder_enabled', '0'],
  ['reminder_hour', '20'],
  ['reminder_minute', '0'],
  ['reminder_lead_days', JSON.stringify([1, 3, 7])],
];
async function ensureDefaultReminderSettings() {
  for (const [key, value] of DEFAULT_REMINDER_SETTINGS) {
    const row = await db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
    if (!row) {
      await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
    }
  }
}

// =====================================================================
//  审计日志（系统日志 + 用户操作日志）
// =====================================================================

/**
 * 时间戳统一用「北京时间」字符串写入，不依赖数据库默认值。
 *
 * 原因：两种驱动的默认值语义不一致 —— SQLite 是 datetime('now','localtime')（本机时区），
 * Supabase(Postgres) 是 to_char(NOW(),...)（实例时区，通常 UTC）。审计日志的时间若一会儿
 * UTC 一会儿本地，排查问题时会误判 8 小时，因此这里在 Node 侧固定折算为北京时间后显式写入。
 */
function beijingTimestamp() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

const AUDIT_TEXT_LIMIT = 4000;   // detail 字段上限，防止超长请求体把库撑爆

function truncate(v, max = AUDIT_TEXT_LIMIT) {
  if (v === null || v === undefined) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return null;
  return s.length > max ? s.slice(0, max) + '…(已截断)' : s;
}

/**
 * 写入一条审计日志。
 *
 * 【契约】本函数永不抛错。审计是旁路能力，绝不能因为日志写失败而让正常业务请求 500。
 * 失败时只在控制台留痕，返回 false。
 */
async function writeAuditLog(entry = {}) {
  try {
    await db.prepare(`
      INSERT INTO audit_logs
        (log_type, category, action, target_type, target_id, summary, detail, status,
         operator, operator_id, operator_role, ip, user_agent, method, path, status_code,
         duration_ms, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      entry.log_type === 'system' ? 'system' : 'user',
      entry.category || null,
      entry.action || null,
      entry.target_type || null,
      entry.target_id != null ? String(entry.target_id) : null,
      truncate(entry.summary, 500),
      truncate(entry.detail),
      entry.status === 'failure' ? 'failure' : 'success',
      entry.operator || '系统',
      entry.operator_id != null ? Number(entry.operator_id) : null,
      entry.operator_role || null,
      entry.ip || null,
      truncate(entry.user_agent, 300),
      entry.method || null,
      truncate(entry.path, 300),
      entry.status_code != null ? Number(entry.status_code) : null,
      entry.duration_ms != null ? Number(entry.duration_ms) : null,
      entry.created_at || beijingTimestamp()
    );
    return true;
  } catch (e) {
    console.error('[审计] 写入失败（已忽略，不影响业务）:', e && e.message ? e.message : e);
    return false;
  }
}

// 把筛选条件编译为 WHERE 子句 + 参数数组，供列表/计数复用，避免两处条件写歪导致分页错乱。
function buildAuditWhere(f = {}) {
  const where = [];
  const params = [];
  if (f.log_type === 'system' || f.log_type === 'user') {
    where.push('log_type = ?');
    params.push(f.log_type);
  }
  if (f.category) { where.push('category = ?'); params.push(f.category); }
  if (f.action) { where.push('action = ?'); params.push(f.action); }
  if (f.status === 'success' || f.status === 'failure') {
    where.push('status = ?');
    params.push(f.status);
  }
  if (f.operator) { where.push('operator = ?'); params.push(f.operator); }
  // 起止日期按 created_at 文本前缀比较（格式固定 'YYYY-MM-DD HH:MM:SS'，字典序即时间序）
  if (f.date_from) { where.push('created_at >= ?'); params.push(String(f.date_from).slice(0, 10) + ' 00:00:00'); }
  if (f.date_to) { where.push('created_at <= ?'); params.push(String(f.date_to).slice(0, 10) + ' 23:59:59'); }
  if (f.keyword) {
    // 关键字模糊匹配摘要/操作对象/操作者/路径
    where.push('(summary LIKE ? OR target_id LIKE ? OR operator LIKE ? OR path LIKE ?)');
    const kw = '%' + f.keyword + '%';
    params.push(kw, kw, kw, kw);
  }
  return { clause: where.length ? ' WHERE ' + where.join(' AND ') : '', params };
}

async function countAuditLogs(filters = {}) {
  const { clause, params } = buildAuditWhere(filters);
  const row = await db.prepare('SELECT COUNT(*) AS total FROM audit_logs' + clause).get(...params);
  return row ? Number(row.total) || 0 : 0;
}

/**
 * 分页查询审计日志。返回 { list, total, page, pageSize }。
 * 排序固定 created_at DESC, id DESC —— 同秒内多条也能稳定分页（仅按 created_at 排序会翻页错乱）。
 */
async function listAuditLogs(filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize) || 20));
  const { clause, params } = buildAuditWhere(filters);
  const total = await countAuditLogs(filters);
  const list = await db.prepare(
    'SELECT * FROM audit_logs' + clause + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?'
  ).all(...params, pageSize, (page - 1) * pageSize);
  return { list: Array.isArray(list) ? list : [], total, page, pageSize };
}

// 概览统计：供审计页顶部卡片展示（总数/系统/用户/失败/今日）
async function getAuditLogStats() {
  const today = beijingTimestamp().slice(0, 10);
  const row = await db.prepare(
    'SELECT COUNT(*) AS total, ' +
    "SUM(CASE WHEN log_type = 'system' THEN 1 ELSE 0 END) AS system_count, " +
    "SUM(CASE WHEN log_type = 'user' THEN 1 ELSE 0 END) AS user_count, " +
    "SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failure_count, " +
    'SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today_count ' +
    'FROM audit_logs'
  ).get(today + ' 00:00:00');
  return {
    total: Number(row && row.total) || 0,
    system: Number(row && row.system_count) || 0,
    user: Number(row && row.user_count) || 0,
    failure: Number(row && row.failure_count) || 0,
    today: Number(row && row.today_count) || 0,
  };
}

// 按保留天数清理历史日志（管理员手动触发）。返回删除条数。
async function cleanupAuditLogs(keepDays) {
  const days = Math.max(0, Number(keepDays) || 0);
  const cutoffMs = Date.now() + 8 * 3600 * 1000 - days * 86400000;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 19).replace('T', ' ');
  const r = await db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
  return { deleted: (r && r.changes) || 0, cutoff };
}

// =====================================================================
//  存储状态诊断（供 /api/storage/status 与设置页展示）
// =====================================================================

async function getStorageStatus() {
  let counts = null;
  try {
    const r = await db.prepare(
      'SELECT (SELECT COUNT(*) FROM tasks) AS tasks, ' +
      '(SELECT COUNT(*) FROM users) AS users, ' +
      '(SELECT COUNT(*) FROM email_recipients) AS recipients'
    ).all();
    counts = r[0] || null;
  } catch (e) { /* ignore */ }

  const driver = DRIVER || (SUPABASE_CONFIGURED ? 'supabase' : 'sqlite');
  return {
    driver,
    offline: FREEDOM_OFFLINE,
    loadSource: driver,
    supabase: {
      urlConfigured: !!SUPABASE_URL,
      keyConfigured: !!SUPABASE_KEY,
      connected: driver === 'supabase',
      // 降级后 driver 会变成 sqlite，这里必须【无条件】暴露失败原因，否则永远查不到根因
      connectError: _supabaseError,
      lastSaveOk: _lastWriteOk,
      lastSaveError: _lastWriteError,
      lastSaveAt: _lastWriteAt ? new Date(_lastWriteAt).toISOString() : null
    },
    sqlite: {
      active: driver === 'sqlite',
      engine: _sqliteEngine,
      initError: _sqliteError,
      note: driver === 'sqlite' ? '数据仅进程内，重启/Vercel 冷启动不持久' : null
    },
    counts
  };
}

// 最近一次写结果（供写接口在响应中注入 persistWarning，统一暴露持久化失败）
function getLastSave() {
  const driver = DRIVER || (SUPABASE_CONFIGURED ? 'supabase' : 'sqlite');
  const configured = driver === 'sqlite' ? true : SUPABASE_CONFIGURED;
  const ok = driver === 'sqlite' ? true : (SUPABASE_CONFIGURED && _lastWriteOk !== false);
  return {
    configured,
    ok,
    driver,
    error: _lastWriteError || (driver === 'supabase' && !SUPABASE_CONFIGURED
      ? 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置到运行时：数据无法持久化。' : null),
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
  ensureDefaultReminderSettings,
  getStorageStatus,
  initDefaultAdmin: initDefaultAdminExport,
  getUserById,
  getUserByUsername,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  init,
  ensureReady,
  // 审计日志（系统日志 + 用户操作日志）
  writeAuditLog,
  listAuditLogs,
  countAuditLogs,
  getAuditLogStats,
  cleanupAuditLogs,
  // 内置种子数据导入（init 内部自动调用；导出仅供回归测试验证幂等性）
  importEmbeddedSeed,
  // 存储彻底不可用时的清晰原因（可用时为 null）
  storageFailure,
  // 诊断用：当前实际生效的驱动
  driver: () => DRIVER || (SUPABASE_CONFIGURED ? 'supabase' : 'sqlite')
};

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
 *      ② SQLite 驱动：sql.js（浏览器/Node 可用的 WASM SQLite），作为离线/兜底。
 *         未配置 Supabase 或连接失败时自动降级，保证应用始终能跑起来（数据仅进程内，重启不持久）。
 *   - 方言策略：业务代码统一写 SQLite 风格 SQL；Supabase 模式下由「翻译层」转成 Postgres；
 *     SQLite 模式直接原生执行。这样同一份 SQL 在两种数据库都能跑。
 *
 * ── 环境变量 ──
 *   SUPABASE_URL              —— 项目地址，形如 https://<project-ref>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY —— 服务角色密钥（Settings → API → service_role），拥有建表/读写全表权限（推荐）
 *   SUPABASE_ANON_KEY         —— 匿名密钥（用户最初提供）；后端仅在无 service_role 时回退使用，
 *                                exec_sql 已授权 anon，但密钥仅应留在服务端，切勿下发到前端。
 *   未配置以上任意一项 → 自动使用本地 SQLite 兜底。
 */

const { createClient } = require('@supabase/supabase-js');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

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

let DRIVER = null;            // 'supabase' | 'sqlite'（init 后确定）
let _supabaseError = null;    // supabase 连接/exec_sql 失败原因（降级时记录）
let _sqliteError = null;      // SQLite 兜底自身也起不来的原因（如 wasm 未打包）

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
  return SUPABASE_CONFIGURED ? 'supabase' : 'sqlite';
}

// ===================== 持久化状态（用于运行态诊断）=====================
let _lastWriteOk = null;     // 最近一次写是否成功（null=尚无写入）
let _lastWriteError = null;
let _lastWriteAt = 0;
let _schemaReady = false;

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
`;

// =====================================================================
//  初始化
// =====================================================================

async function ensureSchema() {
  if (_schemaReady) return;
  if (activeDriver() === 'supabase') {
    await db.exec(SCHEMA_POSTGRES);
  } else {
    const s = await getSqlite();
    // 必须走 exec（支持多条 CREATE 语句），Database.run 只执行单条
    s.exec(SCHEMA_SQLITE);
  }
  _schemaReady = true;
  console.log('[存储] 表结构已就绪（11 张表）');
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
    // 优先 Supabase；配置齐全则探活 + 确认 exec_sql 可用
    if (SUPABASE_CONFIGURED) {
      try {
        const { data: d2, error: e2 } = await getSupabase().rpc('exec_sql', { sql: 'SELECT 1', params: [] });
        if (e2) throw new Error((e2 && e2.message) || JSON.stringify(e2));
        if (!Array.isArray(d2) || d2.length === 0) throw new Error('exec_sql 返回空，连接可能异常');
        DRIVER = 'supabase';
        await ensureSchema();
        await initDefaultAdmin();
        console.log('[存储] 已连接 Supabase（JS 客户端 via exec_sql RPC）');
        return;
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        console.error('[存储] ⚠️ Supabase 连接/exec_sql 失败，降级到本地 SQLite 兜底:', msg);
        _supabaseError = msg;
        // 继续走 sqlite 兜底
      }
    }
    // SQLite 离线/兜底
    // 注意：这里【绝不允许抛异常】。init() 由 api/index.js 在每个请求前 await，
    // 一旦抛出会让所有接口（含 /api/health）都变成 500，反而看不到真正的失败原因。
    DRIVER = 'sqlite';
    try {
      await ensureSchema();
      await initDefaultAdmin();
      console.log('[存储] 使用本地 SQLite 兜底（数据仅进程内，Vercel 冷启动/重启不持久）');
    } catch (e) {
      _sqliteError = e && e.message ? e.message : String(e);
      console.error('[存储] ✗ SQLite 兜底也初始化失败:', _sqliteError);
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
  if (!_sqliteError) return null;
  if (SUPABASE_CONFIGURED) {
    return '数据库不可用。Supabase 连接失败：' + (_supabaseError || '未知原因') +
      '；SQLite 兜底同样失败：' + _sqliteError +
      '。请确认已在 Supabase SQL Editor 执行 scripts/exec_sql.sql 创建 exec_sql 函数，并检查 SUPABASE_URL / SUPABASE_ANON_KEY 是否已注入运行时。';
  }
  return '数据库不可用：未配置 SUPABASE_URL / SUPABASE_ANON_KEY，且 SQLite 兜底初始化失败：' + _sqliteError;
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
  // 存储彻底不可用时的清晰原因（可用时为 null）
  storageFailure,
  // 诊断用：当前实际生效的驱动
  driver: () => DRIVER || (SUPABASE_CONFIGURED ? 'supabase' : 'sqlite')
};

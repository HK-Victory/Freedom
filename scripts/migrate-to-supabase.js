/**
 * 迁移脚本：将旧版（Vercel Blob + sql.js 单文件快照）的数据导入新建的 Supabase Postgres。
 *
 * 用法：
 *   1) 从本地 sqlite 文件导入（推荐先把旧 Blob 快照下载为 freedom-db.sqlite）：
 *      SUPABASE_DB_URL="postgresql://postgres:xxx@db.xxx.supabase.co:5432/postgres" \
 *        node scripts/migrate-to-supabase.js --sqlite ./freedom-db.sqlite
 *
 *   2) 直接从 Vercel Blob 读取（需同时配置旧 Blob 凭据）：
 *      BLOB_READ_WRITE_TOKEN="..." SUPABASE_DB_URL="..." \
 *        node scripts/migrate-to-supabase.js --from-blob
 *
 * 说明：
 *   - 按自然键（task_id / username / email 等）幂等导入，重复执行安全。
 *   - 迁移前会清空目标表（一次性迁移，确保以旧数据为基准）。
 *   - 需要先 `npm install`（devDependencies 含 sql.js，用于读取旧 sqlite）。
 */

const { Pool } = require('pg');
const fs = require('fs');

const SUPABASE_DB_URL = process.env.SUPABASE_DB_URL;
if (!SUPABASE_DB_URL) {
  console.error('❌ 请先设置环境变量 SUPABASE_DB_URL（Supabase Postgres 连接串）');
  process.exit(1);
}

const args = process.argv.slice(2);
const sqliteIdx = args.indexOf('--sqlite');
const fromBlob = args.includes('--from-blob');
const sqlitePath = sqliteIdx >= 0 ? args[sqliteIdx + 1] : null;

if (!sqlitePath && !fromBlob) {
  console.error('❌ 请通过 --sqlite <文件> 或 --from-blob 指定旧数据源');
  process.exit(1);
}

// 表 → 用于去重/自然键（无自然键的表按「清空后整体导入」处理）
const TABLES = [
  'tasks', 'documents', 'email_config', 'email_recipients',
  'reminders', 'task_logs', 'task_progress', 'users', 'settings',
  'milestones', 'risks'
];

async function loadSourceRows() {
  if (sqlitePath) {
    if (!fs.existsSync(sqlitePath)) throw new Error(`sqlite 文件不存在: ${sqlitePath}`);
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const buf = fs.readFileSync(sqlitePath);
    const db = new SQL.Database(buf);
    const out = {};
    for (const t of TABLES) {
      try {
        const res = db.exec(`SELECT * FROM ${t}`);
        out[t] = res.length ? res[0].values.map((row) => {
          const obj = {};
          res[0].columns.forEach((c, i) => { obj[c] = row[i]; });
          return obj;
        }) : [];
      } catch (e) { out[t] = []; }
    }
    db.close();
    return out;
  }
  // from-blob：读取旧 Vercel Blob 快照 → 用 sql.js 解析
  const { list, get } = require('@vercel/blob');
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error('从 Blob 迁移需设置 BLOB_READ_WRITE_TOKEN');
  const { blobs } = await list({ token, prefix: 'freedom-db.sqlite', limit: 1 });
  if (!blobs || !blobs.length) throw new Error('Blob 中未找到 freedom-db.sqlite 快照');
  const res = await get(blobs[0].url, { token, access: 'private' });
  const arrayBuffer = await res.arrayBuffer();
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database(Buffer.from(arrayBuffer));
  const out = {};
  for (const t of TABLES) {
    try {
      const r = db.exec(`SELECT * FROM ${t}`);
      out[t] = r.length ? r[0].values.map((row) => {
        const obj = {}; r[0].columns.forEach((c, i) => { obj[c] = row[i]; }); return obj;
      }) : [];
    } catch (e) { out[t] = []; }
  }
  db.close();
  return out;
}

async function importTable(pool, table, rows) {
  if (!rows || !rows.length) { console.log(`  - ${table}: 无数据，跳过`); return; }
  const client = await pool.connect();
  try {
    await client.query(`DELETE FROM ${table}`);
    // 排除自增 id（由 Postgres 重新生成），其余列原样插入
    const sample = rows[0];
    const cols = Object.keys(sample).filter((c) => c !== 'id');
    const colList = cols.join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders})`;
    for (const row of rows) {
      const vals = cols.map((c) => (row[c] === undefined ? null : row[c]));
      await client.query(sql, vals);
    }
    console.log(`  - ${table}: 导入 ${rows.length} 行`);
  } finally {
    client.release();
  }
}

(async () => {
  console.log('▶ 开始迁移到 Supabase Postgres...');
  const source = await loadSourceRows();
  const pool = new Pool({ connectionString: SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    // 确保表结构存在
    await require('../db').ensureReady().catch(() => {});
    for (const t of TABLES) {
      await importTable(pool, t, source[t]);
    }
    console.log('✅ 迁移完成。请登录系统「设置 → 数据存储状态」确认行数。');
  } catch (e) {
    console.error('❌ 迁移失败:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();

/**
 * make-seed.js — 将当前 better-sqlite3 数据库导出为 sql.js 可加载的种子文件 data/seed.b64
 * 仅本地 / CI 使用，运行时(sql.js)直接读取 seed.b64 作为初始数据。
 * 用法：node scripts/make-seed.js
 */
const Database = require('better-sqlite3');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

(async () => {
  const srcPath = path.join(__dirname, '..', 'data', 'tracker.db');
  if (!fs.existsSync(srcPath)) {
    console.error('未找到', srcPath, '，无法生成种子。');
    process.exit(1);
  }
  const src = new Database(srcPath);

  const sqlJsPath = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (file) => path.join(sqlJsPath, file) });
  const dest = new SQL.Database();

  // 1) 复制表结构
  const tables = src.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all();
  for (const t of tables) dest.run(t.sql);

  // 2) 复制数据
  for (const t of tables) {
    const rows = src.prepare(`SELECT * FROM "${t.name}"`).all();
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const stmt = dest.prepare(
      `INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    );
    for (const r of rows) stmt.run(cols.map((c) => r[c]));
    stmt.free();
  }

  const bytes = dest.export();
  const out = path.join(__dirname, '..', 'data', 'seed.b64');
  fs.writeFileSync(out, Buffer.from(bytes).toString('base64'));
  console.log('✅ seed.b64 已生成');
  console.log('   表:', tables.map((t) => t.name).join(', '));
  console.log('   大小:', bytes.length, 'bytes');
})();

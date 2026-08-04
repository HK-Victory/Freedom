// 本地用 PGlite(真 Postgres)验证 exec_sql 函数的字面量替换与返回逻辑。
// 不依赖网络/Supabase，仅验证函数本体正确性。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

// 只取 CREATE FUNCTION 部分（PGlite 不实现角色/GRANT）
const full = fs.readFileSync(path.join(__dirname, 'exec_sql.sql'), 'utf8');
const fnBody = full.split('REVOKE EXECUTE')[0];

function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; }
  else console.log('✓', msg);
}

(async () => {
  const db = new PGlite();
  await db.waitReady;
  await db.query(fnBody);

  // 建测试表
  await db.query(`CREATE TABLE t (
    id BIGSERIAL PRIMARY KEY,
    name TEXT,
    age INTEGER,
    active BOOLEAN,
    note TEXT
  )`);

  // 1) INSERT ... RETURNING id  -> jsonb 数组，可取到 id
  let r = await db.query('SELECT exec_sql($1,$2) AS d', [
    'INSERT INTO t (name, age, active, note) VALUES ($1,$2,$3,$4) RETURNING id',
    JSON.stringify(['Alice', 30, true, "O'Brien"])
  ]);
  const ins = r.rows[0].d;
  assert(Array.isArray(ins) && ins.length === 1 && typeof ins[0].id === 'number', 'INSERT...RETURNING 返回 [{id}]（含单引号转义安全）');
  const newId = ins[0].id;

  // 2) SELECT 行 -> jsonb 数组
  r = await db.query('SELECT exec_sql($1,$2) AS d', ['SELECT name, age, active FROM t WHERE id = $1', JSON.stringify([newId])]);
  const row = r.rows[0].d[0];
  assert(row.name === 'Alice' && row.age === 30 && row.active === true, 'SELECT 返回正确行（数字/布尔类型保留）');

  // 子查询/聚合
  r = await db.query('SELECT exec_sql($1,$2) AS d', ['SELECT COUNT(*) AS c FROM t', JSON.stringify([])]);
  assert(r.rows[0].d[0].c === 1, 'COUNT(*) 聚合返回 {c:1}');

  // 3) 多行
  await db.query('SELECT exec_sql($1,$2) AS d', ['INSERT INTO t (name, age, active) VALUES ($1,$2,$3)', JSON.stringify(['Bob', 25, false])]);
  r = await db.query('SELECT exec_sql($1,$2) AS d', ['SELECT name FROM t ORDER BY id', JSON.stringify([])]);
  assert(Array.isArray(r.rows[0].d) && r.rows[0].d.length === 2, '多行 SELECT 返回数组长度 2');

  // 4) 普通 DML（无 RETURNING）-> {rowCount}
  r = await db.query('SELECT exec_sql($1,$2) AS d', ['UPDATE t SET age = $1 WHERE name = $2', JSON.stringify([31, 'Alice'])]);
  assert(r.rows[0].d.rowCount === 1, 'UPDATE 返回 {rowCount:1}');

  r = await db.query('SELECT exec_sql($1,$2) AS d', ['DELETE FROM t WHERE name = $1', JSON.stringify(['Bob'])]);
  assert(r.rows[0].d.rowCount === 1, 'DELETE 返回 {rowCount:1}');

  // 5) NULL 参数
  r = await db.query('SELECT exec_sql($1,$2) AS d', ['INSERT INTO t (name, note) VALUES ($1,$2) RETURNING id', JSON.stringify(['Carol', null])]);
  assert(Array.isArray(r.rows[0].d) && r.rows[0].d[0].id != null, 'NULL 参数 -> NULL 字面量，插入成功');

  // 6) 防注入：恶意字符串不应破坏语句结构
  r = await db.query('SELECT exec_sql($1,$2) AS d', ['SELECT $1 AS s', JSON.stringify(["x'); DROP TABLE t; --"])]);
  assert(r.rows[0].d[0].s === "x'); DROP TABLE t; --", '恶意输入作为纯字符串值，未破坏 SQL 结构（防注入）');

  console.log('\n=== exec_sql 函数本体验证完成 ===');
})().catch((e) => { console.error('❌ 异常:', e); process.exitCode = 1; });

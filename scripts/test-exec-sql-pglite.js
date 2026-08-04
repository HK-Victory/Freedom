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

  // 7) 【线上事故回归】参数值内部含 "$数字" —— bcrypt 哈希 $2b$10$xxx 是最典型的场景。
  //    旧实现按参数倒序做全局 regexp_replace，替换 $2 把哈希写入 SQL 后，
  //    下一轮替换 $1 会命中哈希里 "$10$" 中的 $1，把语句撕成 '$2b$'admin'0$xxx'，
  //    线上报 syntax error at or near "admin"，导致 Supabase 初始化失败并静默降级。
  const bcryptHash = '$2b$10$9nhsjqgFqQwT136pS3x3yuhJGtl9C3BsPRcup6D1ERpv4qrFbqgmK';
  r = await db.query('SELECT exec_sql($1,$2) AS d', [
    'INSERT INTO t (name, note) VALUES ($1,$2) RETURNING id, name, note',
    JSON.stringify(['admin', bcryptHash])
  ]);
  const bc = r.rows[0].d[0];
  assert(bc.name === 'admin' && bc.note === bcryptHash,
    '参数值含 $1/$2/$10 文本（bcrypt 哈希）时不被二次替换污染');

  // 复现原始事故的完整形态：4 个参数，哈希在 $2，字符串在 $1/$4
  r = await db.query('SELECT exec_sql($1,$2) AS d', [
    'INSERT INTO t (name, note, age, active) VALUES ($1,$2,$3,$4) RETURNING name, note',
    JSON.stringify(['admin', bcryptHash, 1, true])
  ]);
  assert(r.rows[0].d[0].note === bcryptHash, '4 参数含哈希的 INSERT 完整还原（线上 admin 建号语句）');

  // 8) 值含正则替换串元字符 \1 与 &（旧实现用 regexp_replace，这些会被当作反向引用/整体匹配）
  const tricky = 'a&b \\1 c$3d';
  r = await db.query('SELECT exec_sql($1,$2) AS d', ['SELECT $1 AS s', JSON.stringify([tricky])]);
  assert(r.rows[0].d[0].s === tricky, '值含 & 和 \\1 等正则元字符时原样保留');

  // 9) 占位符 $1 与 $10 共存，不能前缀误伤
  const p10 = Array.from({ length: 10 }, (_, i) => 'v' + (i + 1));
  r = await db.query('SELECT exec_sql($1,$2) AS d', ['SELECT $1 AS a, $10 AS b', JSON.stringify(p10)]);
  assert(r.rows[0].d[0].a === 'v1' && r.rows[0].d[0].b === 'v10', '$1 与 $10 共存时各自正确替换');

  console.log('\n=== exec_sql 函数本体验证完成 ===');
})().catch((e) => { console.error('❌ 异常:', e); process.exitCode = 1; });

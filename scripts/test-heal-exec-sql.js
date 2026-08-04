// 验证「自愈」机制：数据库里是旧版有 bug 的 exec_sql 时，
// 用（可能已坏的）exec_sql 以【空参数】重装正确函数本体，能把坏函数覆盖成修复版。
//
// 复现手段：先在 PGlite 装一个【故意写错】的 exec_sql（倒序 + 全局替换 $，
// 即线上事故的同款 bug），确认探针失败；再用该坏函数以空参数重装正确本体，
// 最后确认探针通过、bcrypt 哈希也不再被二次替换。
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

const EXEC_SQL_DEFINITION = require('../api/exec-sql-def');

// 旧版（buggy）exec_sql：倒序遍历参数，对每个 $n 做全局 regexp_replace（线上事故同款）；
// 分支判断用 【子串匹配】——真实 PostgreSQL 里，函数体本身含 SELECT/WITH/RETURNING，
// 旧函数会把「重装用 CREATE 语句」误判成 SELECT 包进 WITH _q AS(CREATE...)，自愈失败。
// 用 position(... in upper(...)) 子串判断忠实复现该误判（比 \mRETURNING\M 词边界更严格，
// 能真正卡住未混淆的载体，使本测试成为「混淆不能丢」的回归护栏）。
const BUGGY_FN = `
CREATE OR REPLACE FUNCTION exec_sql(sql text, params jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  lits text[] := '{}';
  i int; n int; v jsonb; converted text; rc int; result jsonb; is_ret boolean;
BEGIN
  IF params IS NULL OR jsonb_typeof(params) <> 'array' THEN n := 0;
  ELSE n := jsonb_array_length(params); END IF;
  FOR i IN 0 .. n - 1 LOOP
    v := params -> i;
    IF v IS NULL OR v::text = 'null' THEN lits := array_append(lits, 'NULL');
    ELSIF jsonb_typeof(v) = 'boolean' THEN lits := array_append(lits, v::text);
    ELSIF jsonb_typeof(v) = 'number' THEN lits := array_append(lits, v#>>'{}');
    ELSE lits := array_append(lits, quote_literal(v#>>'{}')); END IF;
  END LOOP;
  -- BUG: 倒序 + 全局替换（线上事故同款）
  converted := sql;
  FOR i IN REVERSE n - 1 .. 0 LOOP
    converted := regexp_replace(converted, '\\$' || (i + 1)::text, lits[i + 1], 'g');
  END LOOP;
  is_ret := position('RETURNING' in upper(converted)) > 0
         OR position('SELECT' in upper(converted)) > 0
         OR position('WITH' in upper(converted)) > 0;
  IF upper(converted) LIKE 'SELECT %' OR upper(converted) LIKE 'WITH %' OR is_ret THEN
    EXECUTE 'WITH _q AS (' || converted || ') SELECT coalesce(jsonb_agg(to_jsonb(_q)), ''[]''::jsonb) FROM _q' INTO result;
    RETURN result;
  ELSE
    EXECUTE converted;
    GET DIAGNOSTICS rc = ROW_COUNT;
    RETURN jsonb_build_object('rowCount', rc);
  END IF;
END; $$;
`;

function assert(cond, msg) {
  if (!cond) { console.error('❌ FAIL:', msg); process.exitCode = 1; }
  else console.log('✓', msg);
}

// 与 db.js assertExecSqlNotStale 等价的探针判断
function probeOk(rows) {
  const r = Array.isArray(rows) && rows[0];
  return !!r && r.a === 'X' && r.b === '$1';
}

(async () => {
  const db = new PGlite();
  await db.waitReady;

  // 1) 装旧版（buggy）exec_sql
  await db.query(BUGGY_FN);

  // 2) 探针：旧版应失败。注意旧版会直接抛语法错（syntax error at or near "X''"），
  //    与线上事故完全一致——所以这里允许「抛错」或「返回错误值」两种失败形态。
  let staleThrew = false;
  let stale = null;
  try {
    const r2 = await db.query('SELECT exec_sql($1,$2) AS d', [
      'SELECT $1::text AS a, $2::text AS b',
      JSON.stringify(['X', '$1'])
    ]);
    stale = r2.rows[0].d;
  } catch (e) {
    staleThrew = true;
  }
  assert(staleThrew || !probeOk(stale),
    '旧版 exec_sql 探针失败（' + (staleThrew ? '直接抛 syntax error at or near "X\'\'"（与线上一致）' : 'b="' + (stale && stale[0] && stale[0].b) + '" ≠ "$1"') + '，确认事故形态）');

  // 3) 自愈：用（坏）exec_sql 以空参数重装正确本体
  const healRes = await db.query('SELECT exec_sql($1,$2) AS d', [EXEC_SQL_DEFINITION, '[]']);
  assert(healRes.rows[0].d && typeof healRes.rows[0].d.rowCount === 'number',
    '自愈：经（坏）exec_sql 空参数成功重装函数本体（返回 rowCount）');

  // 4) 探针：重装后应通过
  r = await db.query('SELECT exec_sql($1,$2) AS d', [
    'SELECT $1::text AS a, $2::text AS b',
    JSON.stringify(['X', '$1'])
  ]);
  assert(probeOk(r.rows[0].d), '自愈后探针通过（a=X, b=$1 原样保留）');

  // 5) bcrypt 哈希不再被二次替换（完整回归）
  await db.query(`CREATE TABLE u (id BIGSERIAL PRIMARY KEY, name TEXT, pw TEXT)`);
  const bcryptHash = '$2b$10$9nhsjqgFqQwT136pS3x3yuhJGtl9C3BsPRcup6D1ERpv4qrFbqgmK';
  r = await db.query('SELECT exec_sql($1,$2) AS d', [
    'INSERT INTO u (name, pw) VALUES ($1,$2) RETURNING name, pw',
    JSON.stringify(['admin', bcryptHash])
  ]);
  const bc = r.rows[0].d[0];
  assert(bc.name === 'admin' && bc.pw === bcryptHash, '自愈后 bcrypt 哈希参数原样写入（不再被 $10 误伤）');

  console.log('\n=== exec_sql 自愈机制验证完成 ===');
})().catch((e) => { console.error('❌ 异常:', e); process.exitCode = 1; });

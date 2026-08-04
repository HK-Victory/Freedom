/**
 * 回归测试：Supabase 上若部署的是【旧版有 bug 的 exec_sql】，必须被主动识别，
 * 并给出「重新执行 scripts/exec_sql.sql」这一可操作指引。
 *
 * 背景（真实线上事故）：
 *   旧版 exec_sql 按参数倒序做全局替换 $n，参数值内部含 "$数字" 时会被二次替换。
 *   bcrypt 哈希恰好是 $2b$10$... —— 建 admin 时 SQL 被撕碎，
 *   线上只报一句 `syntax error at or near "admin"`。
 *   该报错完全看不出「函数是旧版、且推代码不会更新它」，是排查耗时最久的一环。
 *
 * 本测试用【旧版替换逻辑】搭一个假 Supabase，断言 db.js 能识别出来并给出正确指引。
 *
 * 必须在独立进程中运行（模块劫持要早于 db.js 加载）。
 */
const Module = require('module');

process.env.SUPABASE_URL = 'https://mock-project.supabase.co';
process.env.SUPABASE_ANON_KEY = 'mock-anon-key';
process.env.FREEDOM_SKIP_SEED = '1';
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_KEY;

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + extra : '')); }
}

// 旧版（有 bug 的）占位符替换：按参数倒序做全局替换
function staleReplace(sql, params) {
  const lits = (params || []).map(v =>
    v === null || v === undefined ? 'NULL'
      : typeof v === 'number' ? String(v)
        : typeof v === 'boolean' ? String(v)
          : "'" + String(v).replace(/'/g, "''") + "'");
  let out = String(sql);
  for (let i = lits.length; i >= 1; i--) {
    out = out.replace(new RegExp('\\$' + i + '\\b', 'g'), lits[i - 1]);
  }
  return out;
}

const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') {
    return {
      createClient: () => ({
        async rpc(fn, args) {
          const sql = String((args && args.sql) || '');
          if (/^\s*SELECT\s+1\b/i.test(sql)) return { data: [{ ok: 1 }], error: null };
          // 用旧逻辑处理探针，复现被污染的结果
          const converted = staleReplace(sql, args && args.params);
          // 旧逻辑下 `SELECT $1::text AS a, $2::text AS b` + ['X','$1'] 会被撕成
          // `SELECT 'X'::text AS a, ''X''::text AS b` —— 真 Postgres 会报语法错
          if (/''X''/.test(converted)) {
            return { data: null, error: { message: 'syntax error at or near "X"' } };
          }
          return { data: [], error: null };
        }
      })
    };
  }
  return origLoad.apply(this, arguments);
};

(async () => {
  console.log('\n\u2500\u2500\u2500 旧版 exec_sql 识别 回归测试 \u2500\u2500\u2500');

  // 先自证「旧逻辑确实会撕碎 SQL」，否则本测试就是摆设
  const broken = staleReplace('SELECT $1::text AS a, $2::text AS b', ['X', '$1']);
  check('旧逻辑确实污染 SQL（测试有效性自证）', /''X''/.test(broken), broken);

  const db = require('../db.js');
  await db.init();

  check('识别失败后降级到 SQLite（服务不中断）', db.driver() === 'sqlite', '实际=' + db.driver());

  const st = await db.getStorageStatus();
  const err = (st && st.supabase && st.supabase.connectError) || '';
  check('明确指出是「旧版有 bug 的实现」', /旧版有 bug/.test(err), err.slice(0, 80));
  check('明确要求重新执行 scripts/exec_sql.sql', /重新完整执行.*exec_sql\.sql/.test(err));
  check('提醒「推代码不会更新数据库里的函数」', /重新部署代码不会更新/.test(err));
  check('保留原始报错便于深查', /syntax error at or near/.test(err));

  // 降级后应用必须仍然可用
  const admin = await db.getUserByUsername('admin');
  check('兜底库可用，admin 已就绪', !!admin && Number(admin.enabled) === 1);

  console.log('\n' + '\u2500'.repeat(52));
  console.log(failed === 0 ? `\u2705 全部通过（${passed} 项）` : `\u274c ${failed} 项失败 / 共 ${passed + failed} 项`);
  Module._load = origLoad;
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\u274c 测试异常:', e); process.exit(1); });

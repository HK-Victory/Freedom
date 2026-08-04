/**
 * 回归测试：Supabase 探活通过、建表成功，但【初始化后半程失败】时，必须能干净降级到 SQLite。
 *
 * 背景（真实线上事故）：
 *   /api/health 同时报两个错——
 *     supabase.connectError = 'syntax error at or near "admin"'   (exec_sql 占位符替换被 bcrypt 哈希污染)
 *     sqlite.initError      = 'no such table: users'
 *   第二个错才是真正的坑：ensureSchema 用一个布尔量 _schemaReady 记忆建表状态，
 *   Supabase 分支建表成功后已把它置为 true，降级到 SQLite 时 ensureSchema 直接 return，
 *   兜底库里一张表都没建 —— 兜底机制形同虚设，且报错比原始故障更具误导性。
 *
 * 本测试模拟该时序：rpc 对探活/DDL 放行，对 INSERT INTO users 报错。
 * 断言：驱动降级为 sqlite、兜底库表结构完整、admin 可登录、健康检查如实暴露 Supabase 失败原因。
 *
 * 必须在独立进程中运行（模块劫持要早于 db.js 加载）。
 */
const Module = require('module');

process.env.SUPABASE_URL = 'https://mock-project.supabase.co';
process.env.SUPABASE_ANON_KEY = 'mock-anon-key';
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_KEY;
delete process.env.SUPABASE_DB_URL;

const FAIL_MSG = 'syntax error at or near "admin"';

// 把 @supabase/supabase-js 换成一个可控的假客户端
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return {
      createClient() {
        return {
          async rpc(fn, args) {
            const sql = String((args && args.sql) || '');
            // 复现事故时序：探活与建表都成功，唯独写入 admin 时炸掉
            if (/INSERT\s+INTO\s+users/i.test(sql)) {
              return { data: null, error: { message: FAIL_MSG } };
            }
            if (/^\s*SELECT\s+1\b/i.test(sql)) return { data: [{ ok: 1 }], error: null };
            // exec_sql 版本探针（db.js 用它识别「数据库里部署的是旧版有 bug 的函数」）。
            // 本测试要复现的是【初始化后半程】失败，故让探针通过，把失败点保留在写 admin。
            if (/AS\s+a\s*,\s*\$2::text\s+AS\s+b/i.test(sql)) {
              return { data: [{ a: 'X', b: '$1' }], error: null };
            }
            if (/^\s*(CREATE|ALTER|DROP)\b/i.test(sql)) return { data: { rowCount: 0 }, error: null };
            if (/^\s*(SELECT|WITH)\b/i.test(sql)) return { data: [], error: null };
            return { data: { rowCount: 0 }, error: null };
          }
        };
      }
    };
  }
  return origLoad.apply(this, arguments);
};

const http = require('http');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + extra : '')); }
}

(async () => {
  console.log('\n\u2500\u2500\u2500 Supabase 初始化中途失败 \u2192 SQLite 兜底 回归测试 \u2500\u2500\u2500');

  const { app, ensureReady } = require('../server');
  await ensureReady();

  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;

  const hRes = await fetch(base + '/api/health');
  const h = await hRes.json();

  check('健康检查不返回 500', hRes.status === 200, 'HTTP ' + hRes.status);
  check('驱动已降级为 sqlite', h.driver === 'sqlite', 'driver=' + h.driver);
  check('如实暴露 Supabase 失败原因', !!(h.supabase && h.supabase.connectError && h.supabase.connectError.includes('admin')),
    h.supabase && h.supabase.connectError);
  check('SQLite 兜底初始化无错（表已建好）', !(h.sqlite && h.sqlite.initError),
    h.sqlite && h.sqlite.initError);
  check('storageError 为空（兜底确实可用）', !h.storageError, h.storageError);

  const lRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const l = await lRes.json();
  check('admin 可在兜底库正常登录（不再报 no such table: users）',
    lRes.status === 200 && l.success === true,
    'HTTP ' + lRes.status + ' ' + (l.error || ''));

  // 兜底库必须建全，而不是只建了 users
  const token = l && (l.token || (l.data && l.data.token));
  if (token) {
    const tRes = await fetch(base + '/api/tasks', { headers: { Authorization: 'Bearer ' + token } });
    check('业务表可用（/api/tasks 正常返回）', tRes.status === 200, 'HTTP ' + tRes.status);
  } else {
    check('业务表可用（/api/tasks 正常返回）', false, '未拿到 token');
  }

  srv.close();
  Module._load = origLoad;

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试执行异常:', e && (e.stack || e.message));
  process.exit(1);
});

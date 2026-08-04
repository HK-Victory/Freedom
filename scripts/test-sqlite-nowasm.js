/**
 * 回归测试：sql.js 的 wasm 文件未随 Serverless 函数包部署时，必须自动回退 asm.js。
 *
 * 背景（真实线上事故）：
 *   Vercel 上所有接口 500，报
 *     ENOENT: no such file or directory, open '/var/task/node_modules/sql.js/dist/sql-wasm.wasm'
 *   原因是 sql.js 用 __dirname 动态拼路径读 .wasm，Vercel 的依赖追踪(NFT)扫不到该文件，
 *   且 vercel.json 的 includeFiles 当时写成了逗号分隔（只支持【单个】glob，需用 {a,b} 花括号）。
 *
 * 本测试用 monkeypatch 让 existsSync 对 .wasm 一律返回 false 来复现该环境，
 * 断言：引擎回退为 asm、初始化无错、登录可用、健康检查不 500。
 *
 * 必须在独立进程中运行（patch 要早于 db.js 加载）。
 */
const fs = require('fs');
const realExists = fs.existsSync;
fs.existsSync = (p) => (typeof p === 'string' && p.endsWith('.wasm')) ? false : realExists(p);

// 强制走 SQLite 兜底分支
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_KEY;
delete process.env.SUPABASE_DB_URL;

const http = require('http');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + extra : '')); }
}

(async () => {
  console.log('\n\u2500\u2500\u2500 wasm 缺失回退 asm.js 回归测试 \u2500\u2500\u2500');

  const { app, ensureReady } = require('../server');
  await ensureReady();

  const srv = http.createServer(app).listen(0);
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;

  const hRes = await fetch(base + '/api/health');
  const h = await hRes.json();

  check('健康检查不返回 500', hRes.status === 200, 'HTTP ' + hRes.status);
  check('SQLite 引擎回退为 asm', h.sqlite && h.sqlite.engine === 'asm', 'engine=' + (h.sqlite && h.sqlite.engine));
  check('SQLite 初始化无错误', !(h.sqlite && h.sqlite.initError), h.sqlite && h.sqlite.initError);
  check('storageError 为空（存储可用）', !h.storageError, h.storageError);

  const lRes = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const l = await lRes.json();
  check('admin 可正常登录（不再报 wasm ENOENT）', lRes.status === 200 && l.success === true,
    'HTTP ' + lRes.status + ' ' + (l.error || ''));

  srv.close();

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试执行异常:', e && (e.stack || e.message));
  process.exit(1);
});

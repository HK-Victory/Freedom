/**
 * scripts/test-storage-mode.js — 存储模式（设置页可切换 + 仅 admin 可见）端到端测试
 *
 * 关键验证点：
 *   1) GET/PUT /api/settings/storage 必须 requireAuth + requireAdmin：未登录 401、普通用户 403、超管 200
 *   2) 超管可在页面切换存储模式（auto / postgres / offline），且偏好持久化到 settings 表
 *   3) 未配置 Supabase 时选 postgres 应被拒绝（400），不会静默降级
 *
 * 实现：不注入 fake db，直接 require 真实 server.js / db.js（环境不配置 SUPABASE_* → 走本地 SQLite），
 * 使 applyStorageMode 在真实 sql.js 内存库上真实执行，验证持久化与运行时切换。
 */

const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

// 清掉一切 Supabase 相关环境变量，强制进入「本地 SQLite」模式，使 applyStorageMode 在真实库上运行
for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_KEY', 'SUPABASE_DB_URL', 'FREEDOM_OFFLINE']) {
  delete process.env[k];
}
process.env.CRON_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

const auth = require('../auth');
const { app } = require('../server');
const db = require('../db');

/* ----------------------------- 测试工具 ----------------------------- */
function request(port, method, p, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { let b; try { b = JSON.parse(d); } catch (e) { b = d; } resolve({ status: res.statusCode, body: b }); });
    });
    r.on('error', reject);
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

(async () => {
  // 真实 db.js 需要先 ensureReady 建表/灌种子（本测试不注入 fake db，故需主动初始化）
  await db.ensureReady();

  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;

  console.log('\n[1] 鉴权边界：未登录 / 普通用户 / 超管');
  let r = await request(port, 'GET', '/api/settings/storage');
  check('未登录 GET → 401', r.status === 401, r.status);

  // 取一个真实超管 id（init 后内置 admin）
  let adminId = 1;
  const users = await request(port, 'GET', '/api/users', { Authorization: 'Bearer ' + auth.signToken({ id: 1, role: 'admin' }) });
  if (users.status === 200 && Array.isArray(users.body)) {
    const a = users.body.find(u => u.role === 'admin');
    if (a) adminId = a.id;
  }
  const adminToken = auth.signToken({ id: adminId, username: 'admin', role: 'admin', display_name: '超管' });

  // 创建一个普通用户用于越权测试
  const created = await request(port, 'POST', '/api/users', { Authorization: 'Bearer ' + adminToken },
    { username: 'viewer_' + Date.now(), password: 'viewer123', role: 'user', display_name: '越权测试员' });
  const viewerId = created.body && created.body.id;
  const userToken = auth.signToken({ id: viewerId, username: 'viewer', role: 'user', display_name: 'v' });

  r = await request(port, 'GET', '/api/settings/storage', { Authorization: 'Bearer ' + userToken });
  check('普通用户 GET → 403（仅 admin 可见）', r.status === 403, r.status);

  r = await request(port, 'PUT', '/api/settings/storage', { Authorization: 'Bearer ' + userToken }, { mode: 'offline' });
  check('普通用户 PUT → 403（仅 admin 可配置）', r.status === 403, r.status);

  r = await request(port, 'GET', '/api/settings/storage', { Authorization: 'Bearer ' + adminToken });
  check('超管 GET → 200', r.status === 200, r.status);
  check('返回字段含 mode / driver / supabaseConfigured', r.body && typeof r.body.mode === 'string' && typeof r.body.driver === 'string' && 'supabaseConfigured' in r.body, r.body);
  const initialMode = r.body.mode;

  console.log('\n[2] 超管切换存储模式（真实落库验证）');
  r = await request(port, 'PUT', '/api/settings/storage', { Authorization: 'Bearer ' + adminToken }, { mode: 'offline' });
  check('PUT offline → 200', r.status === 200, r.status);
  check('响应 mode = offline', r.body && r.body.mode === 'offline', r.body && r.body.mode);

  r = await request(port, 'GET', '/api/settings/storage', { Authorization: 'Bearer ' + adminToken });
  check('再次 GET 确认已持久化：mode = offline', r.body && r.body.mode === 'offline', r.body && r.body.mode);

  r = await request(port, 'PUT', '/api/settings/storage', { Authorization: 'Bearer ' + adminToken }, { mode: 'auto' });
  check('PUT auto → 200', r.status === 200 && r.body.mode === 'auto', r.status);

  r = await request(port, 'PUT', '/api/settings/storage', { Authorization: 'Bearer ' + adminToken }, { mode: 'postgres' });
  check('未配置 Supabase 时 PUT postgres → 400（拒绝静默降级）', r.status === 400, r.status);

  console.log('\n[3] 无效模式值防护');
  r = await request(port, 'PUT', '/api/settings/storage', { Authorization: 'Bearer ' + adminToken }, { mode: 'bogus' });
  check('无效 mode → 400', r.status === 400, r.status);

  server.close();
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });

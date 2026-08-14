/**
 * scripts/test-audit.js — 审计日志模块端到端测试
 *
 * 覆盖三条核心要求：
 *   1) 【系统日志】定时任务调用 / 执行由 lib/audit.js 的 logSystem 记录（cron 鉴权成败均留痕）
 *   2) 【用户操作日志】界面写操作（POST/PUT/DELETE）由 auditMiddleware 自动采集落库
 *   3) 【仅 admin 可见】审计接口 requireAuth + requireAdmin 双重门禁，普通用户 403、未登录 401
 *
 * 实现方式：与 test-cron-e2e.js 一致 —— 用 require.cache 注入内存版 fake db，
 * 再 require 真实 server.js / lib/audit.js，通过真实 HTTP 请求验证行为。
 * fake db 自带内存版 audit_logs 存储，使「中间件采集 → 落库 → 管理员接口读取」形成闭环。
 */

const path = require('path');
const http = require('http');
const express = require('express');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/* ----------------------------- 内存版 fake db ----------------------------- */
// 审计日志内存存储：writeAuditLog 入栈，list/stats/cleanup 从中计算
const auditLog = [];

const fakeDbModule = {
  // 认证需要：requireAuth 会按 token 里的 id 查用户
  getUserById: async (id) => {
    if (id === 1) return { id: 1, username: 'admin', role: 'admin', display_name: '超管', enabled: true };
    if (id === 2) return { id: 2, username: 'staff', role: 'user', display_name: '普通员工', enabled: true };
    return null;
  },
  // 审计写入（永不抛错）
  writeAuditLog: async (entry) => {
    auditLog.push({ id: auditLog.length + 1, created_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' '), ...entry });
    return true;
  },
  countAuditLogs: async (f = {}) => auditLog.filter(row => !f.log_type || row.log_type === f.log_type).length,
  listAuditLogs: async (f = {}) => {
    let rows = auditLog;
    if (f.log_type) rows = rows.filter(r => r.log_type === f.log_type);
    if (f.category) rows = rows.filter(r => r.category === f.category);
    if (f.status === 'success' || f.status === 'failure') rows = rows.filter(r => r.status === f.status);
    return { list: rows, total: rows.length, page: 1, pageSize: 20 };
  },
  getAuditLogStats: async () => ({
    total: auditLog.length,
    system: auditLog.filter(r => r.log_type === 'system').length,
    user: auditLog.filter(r => r.log_type === 'user').length,
    failure: auditLog.filter(r => r.status === 'failure').length,
    today: auditLog.length, // 测试中均为今日
  }),
  cleanupAuditLogs: async (keepDays) => {
    const before = auditLog.length;
    auditLog.length = 0;
    return { deleted: before, cutoff: new Date().toISOString() };
  },
  // 其余被 server.js / auth.js 解构的导出用 no-op 占位，避免 undefined 调用
  db: { prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 0 }) }) },
  getEmailConfig: async () => ({}), upsertEmailConfig: async () => {},
  getReminderSettings: async () => ({ enabled: true, hour: 12, minute: 0, leadDays: [1, 3, 7] }),
  setReminderSettings: async () => {}, getStorageStatus: async () => ({}), getLastSave: async () => null,
  initDefaultAdmin: async () => {}, getUserByUsername: async () => null, listUsers: async () => [],
  createUser: async () => {}, updateUser: async () => {}, deleteUser: async () => {},
  ensureReady: async () => {}, storageFailure: () => false,
};

/* ----------------------------- 注入 require cache ----------------------------- */
process.env.CRON_SECRET = 'test-secret';
const dbPath = path.resolve(__dirname, '../db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDbModule };

const { app } = require('../server');
const auth = require('../auth');
const { auditMiddleware, logSystem, sanitize, matchRoute } = require('../lib/audit');

const adminToken = auth.signToken({ id: 1, username: 'admin', role: 'admin', display_name: '超管' });
const userToken = auth.signToken({ id: 2, username: 'staff', role: 'user', display_name: '普通员工' });

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

/* ================================ 主流程 ================================ */
(async () => {
  // 自包含 mini-app：用真实 auditMiddleware + requireAuth 验证「用户操作日志自动采集」
  const mini = express();
  mini.use(express.json());
  mini.use(auditMiddleware);
  mini.post('/api/tasks', auth.requireAuth, (req, res) => res.json({ ok: true, task_id: 'T99' }));
  mini.put('/api/tasks/:id', auth.requireAuth, (req, res) => res.json({ ok: true }));
  mini.delete('/api/audit-logs', auth.requireAuth, auth.requireAdmin, (req, res) => res.json({ ok: true }));
  mini.get('/api/health', (req, res) => res.json({ ok: true })); // GET 不记录
  const miniServer = http.createServer(mini);
  await new Promise(res => miniServer.listen(0, res));
  const mp = miniServer.address().port;

  console.log('\n[1] 用户操作日志：auditMiddleware 自动采集写请求');
  let before = auditLog.length;
  let r = await request(mp, 'POST', '/api/tasks', { Authorization: 'Bearer ' + adminToken }, { name: '测试任务', password: 'super-secret' });
  check('POST 任务创建 → HTTP 200', r.status === 200, r.status);
  check('POST 写请求已写入一条用户操作日志', auditLog.length === before + 1, auditLog.length - before);
  let last = auditLog[auditLog.length - 1];
  check('日志类型 = user', last.log_type === 'user', last.log_type);
  check('业务分类 = task / action = create', last.category === 'task' && last.action === 'create', { c: last.category, a: last.action });
  check('操作者 = admin（来自 JWT）', last.operator === 'admin', last.operator);
  check('对象 id 抓取 = T99', last.target_id === 'T99', last.target_id);
  check('请求方法/路径被记录', last.method === 'POST' && last.path === '/api/tasks', { m: last.method, p: last.path });
  check('敏感字段 password 已脱敏（detail 中不含明文）', !String(last.detail).includes('super-secret'), last.detail);
  check('失败标志 = success', last.status === 'success', last.status);

  console.log('\n[2] 失败写请求记录为 failure');
  before = auditLog.length;
  r = await request(mp, 'PUT', '/api/tasks/123', { Authorization: 'Bearer ' + adminToken }, { name: 'x' });
  // 路由未校验直接 200，这里用 middleware 的 failure 分支：故意让一个接口 500
  const failApp = express();
  failApp.use(express.json());
  failApp.use(auditMiddleware);
  failApp.post('/api/users', auth.requireAuth, (req, res) => { res.status(500).json({ error: 'db boom' }); });
  const fs2 = http.createServer(failApp); await new Promise(res => fs2.listen(0, res)); const fp = fs2.address().port;
  before = auditLog.length;
  r = await request(fp, 'POST', '/api/users', { Authorization: 'Bearer ' + adminToken }, { username: 'newone', password: 'PLAINTEXT_SECRET_XYZ' });
  check('写请求返回 500 → 审计 status=failure', r.status === 500 && auditLog.length === before + 1, { s: r.status });
  last = auditLog[auditLog.length - 1];
  check('失败原因被写入 summary', last.status === 'failure' && /失败/.test(last.summary), last.summary);
  check('失败详情含错误文案，且密码明文已脱敏（不含原始明文）', /db boom/.test(last.detail) && !last.detail.includes('PLAINTEXT_SECRET_XYZ') && last.detail.includes('***'), last.detail);
  fs2.close();

  console.log('\n[3] GET 读请求不记录（避免日志被浏览刷爆）');
  before = auditLog.length;
  r = await request(mp, 'GET', '/api/health', {});
  check('GET 请求未产生审计日志', auditLog.length === before, auditLog.length - before);

  console.log('\n[4] 系统日志：定时任务调用由 logSystem 记录（鉴权成败均留痕）');
  before = auditLog.length;
  await logSystem({ category: 'cron', action: 'invoke', status: 'failure', summary: '定时提醒端点鉴权失败（来源：外部调用）', method: 'GET', path: '/api/cron/reminders', status_code: 401 });
  await logSystem({ category: 'cron', action: 'execute', status: 'success', summary: '定时提醒任务执行完成：发送3封/跳过0条', method: 'GET', path: '/api/cron/reminders', status_code: 200 });
  check('logSystem 写入 2 条系统日志', auditLog.length === before + 2, auditLog.length - before);
  const sysLogs = auditLog.filter(l => l.log_type === 'system');
  check('系统日志 log_type=system 且 operator=系统', sysLogs.length >= 2 && sysLogs.every(l => l.operator === '系统'), sysLogs.map(l => l.operator));

  console.log('\n[5] 权限边界：审计接口仅 admin 可见（真实 server.js）');
  const srv = http.createServer(app);
  await new Promise(res => srv.listen(0, res));
  const sp = srv.address().port;

  r = await request(sp, 'GET', '/api/audit-logs', {});
  check('未登录访问审计列表 → 401', r.status === 401, r.status);
  r = await request(sp, 'GET', '/api/audit-logs', { Authorization: 'Bearer ' + userToken });
  check('普通用户访问审计列表 → 403（FORBIDDEN）', r.status === 403, r.status);
  r = await request(sp, 'GET', '/api/audit-logs/stats', { Authorization: 'Bearer ' + userToken });
  check('普通用户访问审计统计 → 403', r.status === 403, r.status);
  r = await request(sp, 'DELETE', '/api/audit-logs?keepDays=30', { Authorization: 'Bearer ' + userToken });
  check('普通用户清理审计日志 → 403', r.status === 403, r.status);

  console.log('\n[6] admin 可读取并过滤审计日志（闭环验证：mini-app 采集 → 此处读取）');
  r = await request(sp, 'GET', '/api/audit-logs', { Authorization: 'Bearer ' + adminToken });
  check('admin 访问审计列表 → 200', r.status === 200, r.status);
  check('列表返回了前面采集到的日志（含 task/create 与 system 两条 cron）', r.body.total >= 4, r.body.total);
  r = await request(sp, 'GET', '/api/audit-logs/stats', { Authorization: 'Bearer ' + adminToken });
  check('admin 审计统计 → 200 且 total 与条数一致', r.status === 200 && r.body.total >= 4, r.body);
  // 仅看系统日志
  r = await request(sp, 'GET', '/api/audit-logs?log_type=system', { Authorization: 'Bearer ' + adminToken });
  check('按 log_type=system 过滤生效', r.status === 200 && r.body.list.every(l => l.log_type === 'system'), r.body);

  console.log('\n[7] 脱敏 / 路由映射 单元校验');
  const san = sanitize({ password: 'hunter2', token: 'abc', name: '正常字段' });
  check('sanitize 将 password 替换为 ***', san.password === '***', san);
  check('sanitize 将 token 替换为 ***', san.token === '***', san);
  check('sanitize 保留非敏感字段', san.name === '正常字段', san);
  const mr = matchRoute('POST', '/api/tasks');
  check('matchRoute POST /api/tasks → create', mr && mr.rule.action === 'create', mr && mr.rule.action);
  const mr2 = matchRoute('PUT', '/api/tasks/55/status');
  check('matchRoute PUT /api/tasks/:id/status → update_status（具体路径优先）', mr2 && mr2.rule.action === 'update_status' && mr2.targetId === '55', mr2 && { a: mr2.rule.action, t: mr2.targetId });

  console.log('\n[8] 清理接口（admin）');
  const totalBefore = auditLog.length;
  r = await request(sp, 'DELETE', '/api/audit-logs?keepDays=0', { Authorization: 'Bearer ' + adminToken });
  check('admin 清理 → 200 且 success=true', r.status === 200 && r.body.success === true, r.body);
  check('清理返回删除条数 = 清理前总数', r.body.deleted === totalBefore, { del: r.body.deleted, before: totalBefore });
  // 关键安全点：清理动作本身必须被留痕（管理员无法抹除自己的操作证据），故清理后仅剩「本次清理」这一条记录
  check('清理后仅保留「本次清理」留痕（防止管理员抹除审计证据）', auditLog.length === 1, auditLog.length);
  check('剩余记录即本次清理动作（action=cleanup, operator=admin）', auditLog[0].action === 'cleanup' && auditLog[0].operator === 'admin', auditLog[0]);

  miniServer.close();
  srv.close();
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });

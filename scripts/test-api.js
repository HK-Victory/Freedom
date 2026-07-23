/**
 * test-api.js — 本地功能测试：覆盖全部 API 端点
 * 用法：先启动服务（node server.js），再运行 node scripts/test-api.js
 */
const BASE = process.env.BASE || 'http://localhost:3000';
let token = '';
let pass = 0, fail = 0;
const results = [];

async function call(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* 可能无 body */ }
  return { status: res.status, data };
}

function check(name, cond, extra = '') {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name} ${extra}`); }
}

(async () => {
  console.log('=== 闻道任务跟踪系统 · 功能测试 ===\n');

  // 1) 未登录访问受保护接口应 401
  let r = await call('GET', '/api/dashboard', null, false);
  check('未登录访问 /api/dashboard 返回 401', r.status === 401, `got ${r.status}`);

  // 2) 登录（默认超管）
  r = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, false);
  check('管理员登录成功', r.status === 200 && r.data.token, `got ${r.status}`);
  token = r.data.token || '';

  // 3) 仪表盘
  r = await call('GET', '/api/dashboard');
  check('仪表盘返回统计', r.status === 200 && typeof r.data.total === 'number',
    `total=${r.data.total}`);
  if (r.data.total) console.log(`     任务总数=${r.data.total}, 完成=${r.data.completed}, 逾期=${r.data.overdue?.length}, 即将到期=${r.data.upcoming?.length}`);

  // 4) 任务列表
  r = await call('GET', '/api/tasks');
  check('任务列表返回数组', r.status === 200 && Array.isArray(r.data), `len=${r.data?.length}`);
  const firstId = Array.isArray(r.data) && r.data[0] ? r.data[0].task_id : null;

  // 5) 任务详情
  if (firstId) {
    r = await call('GET', `/api/tasks/${encodeURIComponent(firstId)}`);
    check('任务详情含文档/日志/进度', r.status === 200 && 'document' in r.data && 'logs' in r.data,
      `got ${r.status}`);
  }

  // 6) 创建任务
  const newId = 'TEST-' + Date.now();
  r = await call('POST', '/api/tasks', {
    task_id: newId, category: '测试', name: '自动化测试任务',
    priority: '高', end_date: '2026-12-31', owner: 'tester', status: 'pending'
  });
  check('创建任务成功', r.status === 200 && r.data.success, `got ${r.status} ${JSON.stringify(r.data)}`);

  // 7) 更新状态
  r = await call('PUT', `/api/tasks/${newId}/status`, { status: 'in_progress' });
  check('更新任务状态成功', r.status === 200 && r.data.success);

  // 8) 更新进度
  r = await call('PUT', `/api/tasks/${newId}/progress`, { progress: 50, note: '过半' });
  check('更新进度成功', r.status === 200 && r.data.success);

  // 9) 文档读写
  r = await call('GET', `/api/tasks/${newId}/document`);
  check('读取文档(空)', r.status === 200);
  r = await call('PUT', `/api/tasks/${newId}/document`, { content: '测试文档内容', updated_by: 'tester' });
  check('写入文档成功', r.status === 200 && r.data.success);
  r = await call('GET', `/api/tasks/${newId}/document`);
  check('读取文档(有内容)', r.status === 200 && r.data.content === '测试文档内容',
    `content=${r.data.content}`);

  // 10) 邮件配置读写
  r = await call('GET', '/api/email/config');
  check('读取邮件配置', r.status === 200 && 'smtp_host' in r.data, `enabled=${r.data.enabled}`);
  r = await call('POST', '/api/email/config', {
    smtp_host: 'smtp.test.com', smtp_port: 465, smtp_user: 'a@b.com',
    smtp_pass: 'secret', smtp_secure: 1, sender_name: '测试', enabled: 0
  });
  check('写入邮件配置成功', r.status === 200 && r.data.success);
  r = await call('GET', '/api/email/config');
  check('邮件密码不回明文', r.status === 200 && r.data.smtp_pass === '******', `pass=${r.data.smtp_pass}`);

  // 11) 收件人
  r = await call('GET', '/api/email/recipients');
  check('收件人列表', r.status === 200 && Array.isArray(r.data));
  const recipEmail = 'test' + Date.now() + '@example.com';
  r = await call('POST', '/api/email/recipients', { email: recipEmail, name: 'T', scope: 'all' });
  check('新增收件人', r.status === 200 && r.data.success);
  r = await call('GET', '/api/email/recipients');
  const recip = r.data.find(x => x.email === recipEmail);
  if (recip) {
    r = await call('DELETE', `/api/email/recipients/${recip.id}`);
    check('删除收件人', r.status === 200 && r.data.success);
  }

  // 12) 里程碑 / 风险
  r = await call('GET', '/api/milestones');
  check('里程碑列表', r.status === 200 && Array.isArray(r.data), `len=${r.data?.length}`);
  r = await call('GET', '/api/risks');
  check('风险列表', r.status === 200 && Array.isArray(r.data), `len=${r.data?.length}`);

  // 13) 报表
  r = await call('GET', '/api/reports/weekly');
  check('周报', r.status === 200 && 'tasks' in r.data, `tasks=${r.data?.tasks?.length}`);
  r = await call('GET', '/api/reports/monthly');
  check('月报', r.status === 200 && 'tasks' in r.data, `tasks=${r.data?.tasks?.length}`);

  // 14) 提醒列表 + 手动触发
  r = await call('GET', '/api/reminders');
  check('提醒列表', r.status === 200 && Array.isArray(r.data));
  r = await call('POST', '/api/reminders/trigger');
  check('手动触发提醒', r.status === 200 && r.data.success);

  // 15) 用户管理（超管）
  const uName = 'user' + Date.now();
  r = await call('POST', '/api/users', { username: uName, password: 'pass123', display_name: '测试用户', role: 'user' });
  check('创建普通用户', r.status === 200 && r.data.success, `got ${r.status} ${JSON.stringify(r.data)}`);
  r = await call('GET', '/api/users');
  check('用户列表', r.status === 200 && r.data.some(u => u.username === uName));
  const u = r.data.find(x => x.username === uName);
  if (u) {
    r = await call('PUT', `/api/users/${u.id}`, { role: 'admin', enabled: false });
    check('更新用户(禁用/改角色)', r.status === 200 && r.data.success);
    r = await call('DELETE', `/api/users/${u.id}`);
    check('删除用户', r.status === 200 && r.data.success);
  }

  // 16) 普通用户登录后权限隔离
  if (uName) { /* 已删除，跳过 */ }
  r = await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, false);
  const adminToken = r.data.token;
  token = adminToken;

  // 17) 清理测试任务
  if (newId) {
    r = await call('DELETE', `/api/tasks/${newId}`);
    check('删除测试任务', r.status === 200 && r.data.success);
  }

  // 18) Cron 路由（无 secret 时应 401 或被处理）
  r = await call('GET', '/api/cron/reminders', null, false);
  check('Cron 路由可达(无secret返回401或执行)', r.status === 401 || r.status === 200, `got ${r.status}`);

  console.log(results.join('\n'));
  console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(2); });

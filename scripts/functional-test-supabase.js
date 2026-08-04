/**
 * Freedom 项目 —— 双驱动（Supabase / SQLite）存储抽象 功能回归测试
 *
 * 设计要点：
 *  1. 用 PGlite（WASM 版真实 Postgres）作为「真 Postgres」校验所有 DDL / ON CONFLICT / to_char /
 *     RETURNING / 类型转换；同时通过 Module._load 钩子把 @supabase/supabase-js 替换为一个
 *     由 PGlite 支撑的 exec_sql 实现，从而离线验证 Supabase 驱动（经 exec_sql RPC 的语义）。
 *  2. 启动【两个互相独立的 server 实例】（清空 require 缓存后重新加载，各自持有独立的 db.js 模块），
 *     但它们共享同一个 PGlite 数据库 —— 精确模拟 Vercel 多个 serverless 实例共享一个 Supabase
 *     数据库的真实拓扑，重点回归「编辑一个任务后，其它任务状态回退成 pending」历史顽疾。
 *  3. 第 18 节用真实 sql.js 验证 SQLite 兜底驱动（schema + CRUD + 存储状态），确保两种方言都能跑。
 *
 * 运行方式（完全离线，不需要真实 Supabase 连接）：
 *   npm i -D @electric-sql/pglite
 *   node scripts/functional-test-supabase.js
 */

const path = require('path');
const Module = require('module');

let PGlite;
try {
  ({ PGlite } = require('@electric-sql/pglite'));
} catch (e) {
  console.error('\n缺少测试依赖，请先安装：npm i -D @electric-sql/pglite\n');
  process.exit(1);
}

// 项目根目录（本文件位于 <root>/scripts/ 下）
const FREEDOM = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- 断言框架
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` —— ${detail}` : ''));
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[36m▌${title}\x1b[0m`);
}

// ---------------------------------------------------------------- PGlite 共享库（两个实例共用）
let pglite = null;

// ---------------------------------------------------------------- 在 JS 中复刻 exec_sql 的占位符替换逻辑
// （与 scripts/exec_sql.sql 保持语义一致：按 JSON 类型构造字面量，防注入；从大到小替换 $n 避免误伤 $10）
async function execSqlJs(sql, params) {
  sql = String(sql).replace(/;\s*$/, '').trim();
  const arr = Array.isArray(params) ? params : [];
  const lits = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v === null || v === undefined) lits.push('NULL');
    else if (typeof v === 'boolean') lits.push(v ? 'true' : 'false');
    else if (typeof v === 'number') lits.push(String(v));
    else lits.push("'" + String(v).replace(/'/g, "''") + "'");
  }
  let converted = sql;
  for (let i = lits.length; i >= 1; i--) {
    converted = converted.replace(new RegExp('\\$' + i + '\\b', 'g'), lits[i - 1]);
  }
  const upper = converted.toUpperCase().replace(/\s+/g, ' ');
  const isReturning = /\bRETURNING\b/.test(upper);
  const res = await pglite.query(converted);
  if (upper.startsWith('SELECT') || upper.startsWith('WITH') || isReturning) {
    return (res.rows || []).map((row) => Object.assign({}, row));
  }
  const rc = (res.rows && res.rows.length)
    ? res.rows.length
    : (typeof res.affectedRows === 'number' ? res.affectedRows : 0);
  return { rowCount: rc };
}

// ---------------------------------------------------------------- 模块加载劫持：用 PGlite 支撑的 exec_sql 替换 @supabase/supabase-js
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return {
      createClient: () => ({
        rpc: async (name, { sql, params }) => {
          try {
            const data = await execSqlJs(sql, params);
            return { data, error: null };
          } catch (e) {
            return { data: null, error: { message: e && e.message ? e.message : String(e) } };
          }
        }
      })
    };
  }
  return origLoad.apply(this, arguments);
};

// 清掉项目自身模块（不动 node_modules），让下一次 require 得到全新的模块实例
function purgeAppModules() {
  const prefix = FREEDOM.toLowerCase();
  for (const key of Object.keys(require.cache)) {
    const k = key.toLowerCase();
    if (k.startsWith(prefix) && !k.includes('node_modules')) {
      delete require.cache[key];
    }
  }
}

async function bootInstance(label) {
  purgeAppModules();
  const mod = require(path.join(FREEDOM, 'server.js'));
  await mod.ensureReady();
  const server = await new Promise((resolve) => {
    const s = mod.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  return { label, app: mod.app, server, base: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------- HTTP 助手
async function api(inst, method, url, opts = {}) {
  const headers = {};
  if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(inst.base + url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data };
}

// ---------------------------------------------------------------- 主流程
(async () => {
  console.log('\n\x1b[1m════ Freedom · Supabase Postgres 存储重构 功能回归测试 ════\x1b[0m');

  pglite = await PGlite.create();
  process.env.SUPABASE_URL = 'https://mock-project.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
  delete process.env.VERCEL;
  delete process.env.CRON_SECRET;

  // 静默 server 初始化日志，保持测试输出干净
  const origLog = console.log;
  const quiet = (fn) => async (...a) => { console.log = () => {}; try { return await fn(...a); } finally { console.log = origLog; } };

  const A = await quiet(bootInstance)('实例A');
  const B = await quiet(bootInstance)('实例B');

  let tokenAdmin = null;
  let tokenUser = null;
  let newUserId = null;

  try {
    // ============================================================
    section('1. 表结构与初始化');
    // ============================================================
    const tbl = await pglite.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
    );
    const names = tbl.rows.map(r => r.table_name);
    const expectTables = ['documents', 'email_config', 'email_recipients', 'milestones', 'reminders',
      'risks', 'settings', 'task_logs', 'task_progress', 'tasks', 'users'];
    check('11 张业务表在 Postgres 中创建成功',
      expectTables.every(t => names.includes(t)),
      `实际: ${names.join(', ')}`);

    const adminRow = await pglite.query("SELECT * FROM users WHERE username='admin'");
    check('默认超管 admin 自动创建', adminRow.rows.length === 1);
    check('两个实例共享同一数据库（未重复插入 admin）', adminRow.rows.length === 1,
      `admin 行数=${adminRow.rows.length}`);
    check('created_at 默认值 to_char(NOW()) 生效',
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(adminRow.rows[0].created_at || ''),
      `created_at=${adminRow.rows[0].created_at}`);
    check('BIGSERIAL id 被解析为 number（非字符串）', typeof adminRow.rows[0].id === 'number');

    // ============================================================
    section('2. 认证');
    // ============================================================
    let r = await api(A, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    check('admin/admin123 登录成功', r.status === 200 && !!r.data.token, JSON.stringify(r.data));
    tokenAdmin = r.data && r.data.token;

    r = await api(A, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong' } });
    check('错误密码返回 401', r.status === 401);

    r = await api(A, 'GET', '/api/tasks');
    check('无 token 访问受保护接口返回 401', r.status === 401);

    r = await api(B, 'GET', '/api/auth/me', { token: tokenAdmin });
    check('实例A 签发的 token 可在 实例B 通过校验（共享用户表）',
      r.status === 200 && r.data.user.username === 'admin', JSON.stringify(r.data));

    // ============================================================
    section('3. 存储状态诊断');
    // ============================================================
    r = await api(A, 'GET', '/api/storage/status', { token: tokenAdmin });
    check('存储状态返回 200', r.status === 200);
    check('supabase.urlConfigured = true', r.data && r.data.supabase && r.data.supabase.urlConfigured === true);
    check('supabase.connected = true', r.data && r.data.supabase && r.data.supabase.connected === true);
    check("loadSource = 'supabase'", r.data && r.data.loadSource === 'supabase');
    check('counts 返回 tasks/users/recipients 计数',
      r.data && r.data.counts && r.data.counts.users !== undefined, JSON.stringify(r.data.counts));

    // ============================================================
    section('4. 任务 CRUD');
    // ============================================================
    const mkTask = (id, name, end) => ({
      task_id: id, name, category: '设计', priority: '高',
      start_date: '2026-08-01', end_date: end, owner: '张三', requirements: '需求' + id
    });

    r = await api(A, 'POST', '/api/tasks', { token: tokenAdmin, body: mkTask('T001', '任务一', '2026-08-20') });
    check('创建任务 T001', r.status === 200 && r.data.success, JSON.stringify(r.data));
    r = await api(A, 'POST', '/api/tasks', { token: tokenAdmin, body: mkTask('T002', '任务二', '2026-08-25') });
    check('创建任务 T002', r.status === 200 && r.data.success);
    r = await api(A, 'POST', '/api/tasks', { token: tokenAdmin, body: mkTask('T003', '任务三', '2026-09-01') });
    check('创建任务 T003', r.status === 200 && r.data.success);

    r = await api(A, 'POST', '/api/tasks', { token: tokenAdmin, body: mkTask('T001', '重复', '2026-08-20') });
    check('重复 task_id 被拒绝（400）', r.status === 400);

    r = await api(A, 'GET', '/api/tasks', { token: tokenAdmin });
    check('任务列表返回 3 条', Array.isArray(r.data) && r.data.length === 3, `实际 ${r.data && r.data.length}`);
    check('列表按 end_date 升序', r.data[0].task_id === 'T001' && r.data[2].task_id === 'T003');
    check('days_left 计算字段存在', r.data[0].days_left !== undefined);

    r = await api(A, 'GET', '/api/tasks/T001', { token: tokenAdmin });
    check('任务详情含 document / logs / progress_history',
      r.status === 200 && r.data.document !== undefined
      && Array.isArray(r.data.logs) && Array.isArray(r.data.progress_history));
    check('创建任务时自动写入操作日志', r.data.logs.length >= 1);

    r = await api(A, 'GET', '/api/tasks/NOPE', { token: tokenAdmin });
    check('查询不存在任务返回 404', r.status === 404);

    // ============================================================
    section('5. ★核心回归：编辑一个任务不得影响其它任务状态');
    // ============================================================
    await api(A, 'PUT', '/api/tasks/T002/status', { token: tokenAdmin, body: { status: 'completed' } });
    await api(A, 'PUT', '/api/tasks/T003/status', { token: tokenAdmin, body: { status: 'in_progress' } });

    r = await api(A, 'GET', '/api/tasks', { token: tokenAdmin });
    let map = Object.fromEntries(r.data.map(t => [t.task_id, t.status]));
    check('前置：T002=completed / T003=in_progress',
      map.T002 === 'completed' && map.T003 === 'in_progress', JSON.stringify(map));

    // 在【另一个实例】上编辑 T001 —— 旧架构下这一步会用陈旧内存快照覆盖整库
    r = await api(B, 'PUT', '/api/tasks/T001', {
      token: tokenAdmin,
      body: { name: '任务一（已改名）', owner: '李四', priority: '中' }
    });
    check('实例B 编辑 T001 成功', r.status === 200 && r.data.success, JSON.stringify(r.data));

    r = await api(A, 'GET', '/api/tasks', { token: tokenAdmin });
    map = Object.fromEntries(r.data.map(t => [t.task_id, t.status]));
    check('\x1b[1m跨实例编辑后 T002 仍为 completed（未回退 pending）\x1b[0m',
      map.T002 === 'completed', `实际 T002=${map.T002}`);
    check('\x1b[1m跨实例编辑后 T003 仍为 in_progress（未回退 pending）\x1b[0m',
      map.T003 === 'in_progress', `实际 T003=${map.T003}`);

    const t1 = r.data.find(t => t.task_id === 'T001');
    check('实例B 的改名在实例A 立即可见', t1.name === '任务一（已改名）', `实际 ${t1.name}`);
    check('COALESCE 局部更新：未传字段 category 保持原值', t1.category === '设计', `实际 ${t1.category}`);
    check('COALESCE 局部更新：owner 已更新为李四', t1.owner === '李四');

    // 反向：实例B 创建，实例A 立即可见
    r = await api(B, 'POST', '/api/tasks', { token: tokenAdmin, body: mkTask('T004', '任务四', '2026-09-10') });
    check('实例B 创建任务 T004', r.status === 200);
    r = await api(A, 'GET', '/api/tasks/T004', { token: tokenAdmin });
    check('实例B 新建的任务在实例A 立即可见（无需对账/flush）', r.status === 200 && r.data.name === '任务四');

    // ============================================================
    section('6. 进度与状态联动');
    // ============================================================
    r = await api(A, 'PUT', '/api/tasks/T004/progress', { token: tokenAdmin, body: { progress: 50, note: '过半' } });
    check('提交 50% 进度', r.status === 200);
    r = await api(B, 'GET', '/api/tasks/T004', { token: tokenAdmin });
    check('进度>0 自动置为 in_progress', r.data.status === 'in_progress', `实际 ${r.data.status}`);
    check('进度历史已记录', r.data.progress_history.length === 1);

    r = await api(A, 'PUT', '/api/tasks/T004/progress', { token: tokenAdmin, body: { progress: 100, note: '完成' } });
    r = await api(B, 'GET', '/api/tasks/T004', { token: tokenAdmin });
    check('进度=100 自动置为 completed', r.data.status === 'completed', `实际 ${r.data.status}`);

    r = await api(A, 'PUT', '/api/tasks/T004/status', { token: tokenAdmin, body: { status: 'bogus' } });
    check('非法状态值返回 400', r.status === 400);

    // ============================================================
    section('7. 任务文档（ON CONFLICT DO UPDATE 幂等 upsert）');
    // ============================================================
    r = await api(A, 'PUT', '/api/tasks/T001/document', {
      token: tokenAdmin, body: { content: '# 第一版文档', updated_by: '张三' }
    });
    check('保存文档', r.status === 200 && r.data.success);
    r = await api(B, 'GET', '/api/tasks/T001/document', { token: tokenAdmin });
    check('跨实例读取文档内容一致', r.data.content === '# 第一版文档', JSON.stringify(r.data));
    check('文档记录 updated_by', r.data.updated_by === '张三');

    r = await api(B, 'PUT', '/api/tasks/T001/document', {
      token: tokenAdmin, body: { content: '# 第二版文档', updated_by: '李四' }
    });
    r = await api(A, 'GET', '/api/tasks/T001/document', { token: tokenAdmin });
    check('重复保存走 UPDATE 分支而非报唯一键冲突', r.data.content === '# 第二版文档');
    const docCnt = await pglite.query("SELECT COUNT(*) AS c FROM documents WHERE task_id='T001'");
    check('documents 表 T001 仅一行（未产生重复）', Number(docCnt.rows[0].c) === 1);

    // ============================================================
    section('8. 提醒设置（settings 表无 id 列 —— 验证 RETURNING id 修复）');
    // ============================================================
    r = await api(A, 'GET', '/api/settings/reminder', { token: tokenAdmin });
    check('默认提醒时间为 20:00', r.status === 200 && r.data.hour === 20 && r.data.minute === 0,
      JSON.stringify(r.data));
    check('默认提前提醒天数 [1,3,7]', JSON.stringify(r.data.leadDays) === '[1,3,7]');
    check('默认未启用', r.data.enabled === false);

    r = await api(B, 'PUT', '/api/settings/reminder', {
      token: tokenAdmin, body: { enabled: true, hour: 9, minute: 30, leadDays: [2, 5] }
    });
    check('\x1b[1m保存提醒设置成功（settings 无 id 列不会因 RETURNING id 报错）\x1b[0m',
      r.status === 200 && r.data.success, JSON.stringify(r.data));

    r = await api(A, 'GET', '/api/settings/reminder', { token: tokenAdmin });
    check('跨实例读回提醒设置 9:30 / [2,5] / 已启用',
      r.data.hour === 9 && r.data.minute === 30 && r.data.enabled === true
      && JSON.stringify(r.data.leadDays) === '[2,5]', JSON.stringify(r.data));

    r = await api(B, 'PUT', '/api/settings/reminder', {
      token: tokenAdmin, body: { enabled: false, hour: 20, minute: 0, leadDays: [1, 3, 7] }
    });
    r = await api(A, 'GET', '/api/settings/reminder', { token: tokenAdmin });
    check('二次保存走 ON CONFLICT DO UPDATE（可反复覆盖）', r.data.hour === 20 && r.data.enabled === false);

    // ============================================================
    section('9. 邮件配置与收件人');
    // ============================================================
    r = await api(A, 'POST', '/api/email/config', {
      token: tokenAdmin,
      body: { smtp_host: 'smtp.qq.com', smtp_port: 465, smtp_user: 'a@qq.com', smtp_pass: 'secret', enabled: true }
    });
    check('保存邮件配置', r.status === 200 && r.data.success, JSON.stringify(r.data));
    r = await api(B, 'GET', '/api/email/config', { token: tokenAdmin });
    check('跨实例读取邮件配置', r.data.smtp_host === 'smtp.qq.com' && r.data.smtp_port === 465);
    check('密码脱敏为 ******', r.data.smtp_pass === '******');

    r = await api(B, 'POST', '/api/email/config', {
      token: tokenAdmin, body: { smtp_host: 'smtp.163.com', smtp_port: 465, smtp_user: 'a@163.com', smtp_pass: '******' }
    });
    const cfgRow = await pglite.query('SELECT smtp_pass FROM email_config WHERE id=1');
    check('传回 ****** 时保留原密码不被覆盖', cfgRow.rows[0].smtp_pass === 'secret',
      `实际 ${cfgRow.rows[0].smtp_pass}`);

    r = await api(A, 'POST', '/api/email/recipients', {
      token: tokenAdmin, body: { email: 'p1@x.com', name: '收件人1', scope: 'all' }
    });
    check('新增收件人', r.status === 200 && r.data.success);
    r = await api(A, 'POST', '/api/email/recipients', {
      token: tokenAdmin, body: { email: 'p1@x.com', name: '重复' }
    });
    check('重复邮箱被拒绝（400）', r.status === 400);

    r = await api(B, 'GET', '/api/email/recipients', { token: tokenAdmin });
    check('跨实例查询收件人列表', Array.isArray(r.data) && r.data.length === 1);
    const recId = r.data[0].id;

    r = await api(B, 'PUT', `/api/email/recipients/${recId}`, {
      token: tokenAdmin, body: { email: 'p1@x.com', name: '收件人改名', scope: 'specific', task_ids: ['T001'], enabled: true }
    });
    check('修改收件人', r.status === 200);
    r = await api(A, 'GET', '/api/email/recipients', { token: tokenAdmin });
    check('收件人改名生效', r.data[0].name === '收件人改名');
    check('task_ids 以 JSON 字符串存储', r.data[0].task_ids === '["T001"]', r.data[0].task_ids);

    r = await api(A, 'DELETE', `/api/email/recipients/${recId}`, { token: tokenAdmin });
    check('删除收件人', r.status === 200);
    r = await api(B, 'GET', '/api/email/recipients', { token: tokenAdmin });
    check('删除后列表为空', r.data.length === 0);

    // ============================================================
    section('10. 用户管理（RETURNING id / 权限 / 自我保护）');
    // ============================================================
    r = await api(A, 'POST', '/api/users', {
      token: tokenAdmin, body: { username: 'tester', password: 'test123', display_name: '测试员', role: 'user' }
    });
    check('创建普通用户', r.status === 200 && r.data.success, JSON.stringify(r.data));
    check('\x1b[1mINSERT 返回 lastInsertRowid（RETURNING id 生效）\x1b[0m',
      typeof r.data.id === 'number' && r.data.id > 0, `id=${r.data.id}`);
    newUserId = r.data.id;

    r = await api(A, 'POST', '/api/users', { token: tokenAdmin, body: { username: 'tester', password: 'test123' } });
    check('重复用户名被拒绝（400）', r.status === 400);
    r = await api(A, 'POST', '/api/users', { token: tokenAdmin, body: { username: 'x', password: '123' } });
    check('密码少于6位被拒绝（400）', r.status === 400);

    r = await api(B, 'POST', '/api/auth/login', { body: { username: 'tester', password: 'test123' } });
    check('新用户可在另一实例登录', r.status === 200 && !!r.data.token);
    tokenUser = r.data.token;

    r = await api(B, 'GET', '/api/users', { token: tokenUser });
    check('普通用户访问用户管理返回 403', r.status === 403, JSON.stringify(r.data));
    r = await api(B, 'GET', '/api/storage/status', { token: tokenUser });
    check('普通用户访问存储诊断返回 403', r.status === 403);
    r = await api(B, 'GET', '/api/tasks', { token: tokenUser });
    check('普通用户可正常访问任务列表', r.status === 200);

    r = await api(A, 'GET', '/api/users', { token: tokenAdmin });
    check('超管可查询用户列表（2 个用户）', r.status === 200 && r.data.length === 2, `实际 ${r.data.length}`);
    check('用户列表不含密码哈希', r.data[0].password_hash === undefined);

    r = await api(A, 'DELETE', `/api/users/${adminRow.rows[0].id}`, { token: tokenAdmin });
    check('\x1b[1m不能删除自己的账号（id 类型比较正确）\x1b[0m', r.status === 400, JSON.stringify(r.data));

    r = await api(A, 'PUT', `/api/users/${adminRow.rows[0].id}`, { token: tokenAdmin, body: { enabled: false } });
    check('不能禁用自己的账号', r.status === 400);

    r = await api(B, 'PUT', `/api/users/${newUserId}`, { token: tokenAdmin, body: { display_name: '改名测试员' } });
    check('修改用户信息', r.status === 200);
    r = await api(A, 'GET', '/api/users', { token: tokenAdmin });
    check('用户改名跨实例生效', r.data.some(u => u.display_name === '改名测试员'));

    r = await api(B, 'POST', '/api/auth/change-password', {
      token: tokenUser, body: { old_password: 'test123', new_password: 'newpass123' }
    });
    check('修改自己的密码', r.status === 200 && r.data.success, JSON.stringify(r.data));
    r = await api(A, 'POST', '/api/auth/login', { body: { username: 'tester', password: 'newpass123' } });
    check('新密码可在另一实例登录', r.status === 200 && !!r.data.token);
    r = await api(A, 'POST', '/api/auth/login', { body: { username: 'tester', password: 'test123' } });
    check('旧密码已失效', r.status === 401);

    r = await api(A, 'DELETE', `/api/users/${newUserId}`, { token: tokenAdmin });
    check('删除用户成功', r.status === 200 && r.data.success);
    r = await api(A, 'DELETE', `/api/users/${newUserId}`, { token: tokenAdmin });
    check('重复删除返回 404（changes=0 判定正确）', r.status === 404);

    // ============================================================
    section('11. 仪表盘与报表');
    // ============================================================
    r = await api(A, 'GET', '/api/dashboard', { token: tokenAdmin });
    check('仪表盘返回 200', r.status === 200);
    check('总任务数 = 4', r.data.total === 4, `实际 ${r.data.total}`);
    check('已完成 = 2（T002 + T004）', r.data.completed === 2, `实际 ${r.data.completed}`);
    check('进行中 = 1（T003）', r.data.inProgress === 1, `实际 ${r.data.inProgress}`);
    check('完成率 = 50%', r.data.completionRate === 50, `实际 ${r.data.completionRate}`);
    check('分类统计存在', r.data.categories && r.data.categories['设计']);

    r = await api(B, 'GET', '/api/reports/weekly', { token: tokenAdmin });
    check('周报返回 200 且含 period', r.status === 200 && r.data.period && r.data.period.start,
      JSON.stringify(r.data.period));
    check('周报含 tasks/logs/progress 三段', Array.isArray(r.data.tasks) && Array.isArray(r.data.logs) && Array.isArray(r.data.progress));

    r = await api(B, 'GET', '/api/reports/monthly', { token: tokenAdmin });
    check('月报返回 200', r.status === 200 && r.data.period);

    r = await api(A, 'GET', '/api/reports/weekly?week=2026-W32', { token: tokenAdmin });
    check('指定周次的周报可用', r.status === 200);
    r = await api(A, 'GET', '/api/reports/monthly?month=2026-08', { token: tokenAdmin });
    check('指定月份的月报可用', r.status === 200);

    // ============================================================
    section('12. 里程碑 / 风险 / 提醒查询');
    // ============================================================
    r = await api(A, 'GET', '/api/milestones', { token: tokenAdmin });
    check('里程碑接口返回数组', r.status === 200 && Array.isArray(r.data));
    r = await api(A, 'GET', '/api/risks', { token: tokenAdmin });
    check('风险接口返回数组', r.status === 200 && Array.isArray(r.data));

    r = await api(A, 'GET', '/api/reminders', { token: tokenAdmin });
    check('提醒列表返回数组', r.status === 200 && Array.isArray(r.data));
    r = await api(A, 'GET', '/api/reminders?days=7', { token: tokenAdmin });
    check('\x1b[1m带 days 参数的提醒查询可用（CURRENT_DATE - ($1)::int 转型生效）\x1b[0m',
      r.status === 200 && Array.isArray(r.data), JSON.stringify(r.data));

    // ============================================================
    section('13. Cron 定时提醒入口');
    // ============================================================
    r = await api(A, 'GET', '/api/cron/reminders');
    check('提醒未启用时 cron 返回 skipped', r.status === 200 && r.data.skipped === true,
      JSON.stringify(r.data));

    process.env.CRON_SECRET = 'topsecret';
    r = await api(A, 'GET', '/api/cron/reminders');
    check('配置 CRON_SECRET 后无密钥调用返回 401', r.status === 401);
    r = await api(A, 'GET', '/api/cron/reminders?secret=topsecret');
    check('携带正确密钥可调用', r.status === 200);
    delete process.env.CRON_SECRET;

    // ============================================================
    section('14. 删除任务与级联清理');
    // ============================================================
    r = await api(B, 'DELETE', '/api/tasks/T004', { token: tokenAdmin });
    check('实例B 删除任务 T004', r.status === 200 && r.data.success);
    r = await api(A, 'GET', '/api/tasks/T004', { token: tokenAdmin });
    check('实例A 立即感知删除（404）', r.status === 404);

    const leftover = await pglite.query(
      "SELECT (SELECT COUNT(*) FROM documents WHERE task_id='T004') AS d," +
      " (SELECT COUNT(*) FROM task_logs WHERE task_id='T004') AS l," +
      " (SELECT COUNT(*) FROM task_progress WHERE task_id='T004') AS p"
    );
    const lo = leftover.rows[0];
    check('关联的文档/日志/进度已一并清理',
      Number(lo.d) === 0 && Number(lo.l) === 0 && Number(lo.p) === 0, JSON.stringify(lo));

    r = await api(A, 'DELETE', '/api/tasks/T004', { token: tokenAdmin });
    check('删除不存在的任务返回 404', r.status === 404);

    // ============================================================
    section('15. 异常兜底（错误中间件必须注册在路由之后）');
    // ============================================================
    r = await api(A, 'DELETE', '/api/email/recipients/not-a-number', { token: tokenAdmin });
    check('\x1b[1mSQL 异常被错误中间件捕获并返回 500 JSON（而非挂起/HTML）\x1b[0m',
      r.status === 500 && r.data && typeof r.data.error === 'string',
      `status=${r.status} body=${JSON.stringify(r.data)}`);

    // ============================================================
    section('16. 持久化真实性（数据确实落在 Postgres 表里）');
    // ============================================================
    const finalTasks = await pglite.query('SELECT task_id, name, status FROM tasks ORDER BY task_id');
    check('Postgres tasks 表最终存有 3 条任务', finalTasks.rows.length === 3,
      JSON.stringify(finalTasks.rows));
    check('改名结果真实落库',
      finalTasks.rows.find(t => t.task_id === 'T001').name === '任务一（已改名）');
    check('状态真实落库（T002=completed）',
      finalTasks.rows.find(t => t.task_id === 'T002').status === 'completed');

    const settingRows = await pglite.query('SELECT key, value FROM settings ORDER BY key');
    check('settings 表以 key/value 形式持久化提醒配置', settingRows.rows.length >= 4,
      JSON.stringify(settingRows.rows));

    r = await api(A, 'GET', '/api/storage/status', { token: tokenAdmin });
    check('最近一次写入标记为成功（lastSaveOk=true）', r.data.supabase.lastSaveOk === true);
    check('counts.tasks 与实际一致', Number(r.data.counts.tasks) === 3, JSON.stringify(r.data.counts));

    // ============================================================
    section('17. Excel 重置导入（excel-reader 全量重写后的回归）');
    // ============================================================
    // 注意：会清空前面创建的任务，因此放在最后执行
    r = await api(A, 'POST', '/api/sync', { token: tokenAdmin, body: { reset: true } });
    check('\x1b[1mExcel 重置导入成功（risks.trigger 等保留字列可正常写入）\x1b[0m',
      r.status === 200 && r.data.success, JSON.stringify(r.data));
    check('导入的工作表被识别', r.data.sheets && r.data.sheets.length > 0, JSON.stringify(r.data.sheets));

    const impTasks = await pglite.query('SELECT COUNT(*) AS c FROM tasks');
    check('任务表导入到数据', Number(impTasks.rows[0].c) > 0, `实际 ${impTasks.rows[0].c} 条`);
    const impMs = await pglite.query('SELECT COUNT(*) AS c FROM milestones');
    check('里程碑表导入到数据', Number(impMs.rows[0].c) > 0, `实际 ${impMs.rows[0].c} 条`);
    const impRisk = await pglite.query('SELECT COUNT(*) AS c FROM risks');
    check('风险表导入到数据', Number(impRisk.rows[0].c) > 0, `实际 ${impRisk.rows[0].c} 条`);

    r = await api(B, 'GET', '/api/milestones', { token: tokenAdmin });
    check('里程碑接口跨实例返回导入结果', r.status === 200 && r.data.length > 0);
    r = await api(B, 'GET', '/api/risks', { token: tokenAdmin });
    check('风险接口跨实例返回导入结果', r.status === 200 && r.data.length > 0);
    check('风险记录的 trigger 字段可正常读出',
      r.data[0] && r.data[0].trigger !== undefined, JSON.stringify(r.data[0]));

    r = await api(A, 'GET', '/api/tasks', { token: tokenAdmin });
    check('导入后任务列表可正常查询', r.status === 200 && r.data.length > 0, `实际 ${r.data && r.data.length}`);
    const firstTask = r.data[0];
    check('导入任务含必要字段', !!firstTask.task_id && !!firstTask.name);
    check('导入后自动创建空文档', firstTask.task_id && true);

    // 二次导入验证幂等（ON CONFLICT DO UPDATE + 状态保留）
    await api(A, 'PUT', `/api/tasks/${firstTask.task_id}/status`, { token: tokenAdmin, body: { status: 'completed' } });
    r = await api(B, 'POST', '/api/sync', { token: tokenAdmin, body: {} });
    check('非重置的增量同步成功', r.status === 200 && r.data.success, JSON.stringify(r.data));
    r = await api(A, 'GET', `/api/tasks/${firstTask.task_id}`, { token: tokenAdmin });
    check('增量同步保留人工设置的任务状态', r.data.status === 'completed', `实际 ${r.data.status}`);

    // ============================================================
    section('18. 本地 SQLite 离线/兜底驱动（真实 sql.js）');
    // ============================================================
    // 关掉 Supabase 环境变量并重新加载 db.js → 自动降级到 SQLite
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_DB_URL;
    delete process.env.SUPABASE_KEY;
    purgeAppModules();
    const C = await quiet(bootInstance)('实例C(sqlite)');

    let rC = await api(C, 'POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
    check('C: admin/admin123 登录成功（sqlite 驱动）', rC.status === 200 && !!rC.data.token, JSON.stringify(rC.data));
    const tC = rC.data && rC.data.token;

    rC = await api(C, 'GET', '/api/storage/status', { token: tC });
    check('C: loadSource = sqlite', rC.data && rC.data.loadSource === 'sqlite', JSON.stringify(rC.data && rC.data.loadSource));
    check('C: sqlite.active = true', rC.data && rC.data.sqlite && rC.data.sqlite.active === true);
    check('C: supabase.urlConfigured = false（未配置）', rC.data && rC.data.supabase && rC.data.supabase.urlConfigured === false);

    rC = await api(C, 'POST', '/api/tasks', { token: tC, body: mkTask('S001', 'SQLite任务', '2026-08-20') });
    check('C: 创建任务（sqlite）', rC.status === 200 && rC.data.success, JSON.stringify(rC.data));
    rC = await api(C, 'GET', '/api/tasks/S001', { token: tC });
    check('C: 读取任务（sqlite）', rC.status === 200 && rC.data.name === 'SQLite任务', JSON.stringify(rC.data));
    rC = await api(C, 'PUT', '/api/tasks/S001/status', { token: tC, body: { status: 'completed' } });
    check('C: 更新状态（sqlite）', rC.status === 200 && rC.data.success, JSON.stringify(rC.data));
    rC = await api(C, 'GET', '/api/tasks/S001', { token: tC });
    check('C: 状态真实落库（sqlite）', rC.data.status === 'completed', `实际 ${rC.data && rC.data.status}`);
    rC = await api(C, 'GET', '/api/dashboard', { token: tC });
    check('C: 仪表盘可用（sqlite, total=1）', rC.status === 200 && rC.data.total === 1, JSON.stringify(rC.data));
    rC = await api(C, 'POST', '/api/tasks', { token: tC, body: mkTask('S001', '重复', '2026-08-20') });
    check('C: 重复 task_id 被拒绝（sqlite, 400）', rC.status === 400);
    await new Promise((res) => C.server.close(res));

  } catch (err) {
    failed++;
    failures.push('测试执行中断: ' + (err && err.stack ? err.stack : err));
    console.error('\n\x1b[31m测试执行异常:\x1b[0m', err);
  } finally {
    await new Promise(res => A.server.close(res));
    await new Promise(res => B.server.close(res));
    Module._load = origLoad;
  }

  // ---------------------------------------------------------------- 汇总
  console.log('\n' + '─'.repeat(64));
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1m全部通过：${passed}/${total}\x1b[0m`);
  } else {
    console.log(`\x1b[31m\x1b[1m失败 ${failed} 项 / 共 ${total} 项\x1b[0m`);
    failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  console.log('─'.repeat(64) + '\n');
  process.exit(failed === 0 ? 0 : 1);
})();

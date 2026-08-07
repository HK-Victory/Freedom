/**
 * scripts/test-cron-e2e.js — Vercel 定时提醒（/api/cron/reminders）端到端测试
 *
 * 目标：在完全离线、可复现的环境下，认真验证 Vercel Cron 触发的完整逻辑链：
 *   1) 鉴权：Vercel 明文 Bearer <CRON_SECRET>（以及保留的 ?secret= 手动入口）
 *   2) 提醒总开关门：getReminderSettings().enabled === false → 直接跳过，不发送
 *   3) 北京时间小时门：仅在 beijingNow().h === 配置 hour 时才发送，否则跳过（关键：不能误发）
 *   4) 邮件总开关门：email_config.enabled === 0 → 跳过，不发送
 *   5) 实际发送：仅「临期(今日/落在提前天数) + 逾期」被选中，已完成/远期/无截止日任务被排除
 *   6) 当日去重：同一 UTC 日二次触发（force=false）应 skipped 全部、sent=0
 *   7) 强制重发：checkAndSendReminders({force:true}) 复用当日记录并重发
 *
 * 实现方式：用 require cache 注入内存版 fake db / fake email，再 require 真实 server.js
 * 拿到已注册路由的 express app，通过真实 HTTP 请求打到 /api/cron/reminders。
 * （require.main 守卫保证 require server 不会真正 listen，环境安全。）
 */

const path = require('path');
const http = require('http');
const fs = require('fs');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

/* ----------------------------- fake db / email ----------------------------- */
let tasks = [];
let reminders = [];
let rid = 0;
let emailConfigEnabled = 1;
let reminderCfg = { enabled: true, hour: 0, minute: 0, leadDays: [1, 3, 7] };
let emailCalls = [];

const db = {
  prepare(sql) {
    sql = (sql || '').toString();
    const lower = sql.toLowerCase();
    if (lower.includes('from email_config')) {
      // 注意：sqlite/pg 风格的 .get() 返回「单行对象」而非数组
      return { get() { return { enabled: emailConfigEnabled ? 1 : 0 }; } };
    }
    if (lower.includes('from tasks')) {
      // 复刻 SQL 的 WHERE status != 'completed' AND end_date IS NOT NULL AND end_date != ''
      const rows = tasks.filter(t => t.status !== 'completed' && t.end_date && String(t.end_date).trim() !== '');
      return { all() { return rows; } };
    }
    if (lower.includes('from reminders') || (lower.includes('reminders') && !lower.includes('from tasks'))) {
      if (lower.trim().startsWith('select')) {
        return { get(taskId, date) {
          const r = reminders.find(x => x.task_id === taskId && x.reminder_date === date && x.sent === 1);
          return r ? { id: r.id } : undefined;
        } };
      }
      if (lower.includes('insert')) {
        return { run(taskId, date, days) { reminders.push({ id: ++rid, task_id: taskId, reminder_date: date, days_before: days, sent: 0 }); } };
      }
      if (lower.includes('update')) {
        return { run(...args) {
          if (lower.includes('sent = 0')) { const r = reminders.find(x => x.id === args[0]); if (r) r.sent = 0; }
          else if (lower.includes('sent = 1')) { reminders.forEach(x => { if (x.task_id === args[0] && x.reminder_date === args[1]) x.sent = 1; }); }
        } };
      }
    }
    return { all() { return []; }, get() { return undefined; }, run() {} };
  }
};

const fakeDbModule = {
  db,
  getReminderSettings: async () => reminderCfg,
  // 其余被 server.js 解构的导出名用 no-op 占位，避免 undefined 调用
  getEmailConfig: async () => ({}), upsertEmailConfig: async () => {}, setReminderSettings: async () => {},
  getStorageStatus: async () => ({}), getLastSave: async () => null, initDefaultAdmin: async () => {},
  getUserByUsername: async () => null, listUsers: async () => [], createUser: async () => {},
  updateUser: async () => {}, deleteUser: async () => {}, ensureReady: async () => {}, storageFailure: () => false,
};

const fakeEmailModule = {
  sendTaskReminder: async (task, days) => { emailCalls.push({ task_id: task.task_id, days }); return { sent: true }; },
};

/* ----------------------------- 注入 require cache ----------------------------- */
process.env.CRON_SECRET = 'test-secret';
const dbPath = path.resolve(__dirname, '../db.js');
const emailPath = path.resolve(__dirname, '../email.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDbModule };
require.cache[emailPath] = { id: emailPath, filename: emailPath, loaded: true, exports: fakeEmailModule };

const { app } = require('../server');
const { checkAndSendReminders } = require('../scheduler');

/* ----------------------------- 测试工具 ----------------------------- */
function isoDay(offset) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function beijingHour() { return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours(); }

function resetState(opts = {}) {
  tasks = opts.tasks ? opts.tasks.slice() : [];
  reminders = [];
  rid = 0;
  emailCalls = [];
  emailConfigEnabled = opts.emailEnabled !== undefined ? opts.emailEnabled : 1;
  reminderCfg = opts.cfg || { enabled: true, hour: beijingHour(), minute: 0, leadDays: [1, 3, 7] };
}

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

const dueTasks = () => [
  { task_id: 'T1', name: '逾期任务', status: 'pending', end_date: isoDay(-3) },
  { task_id: 'T2', name: '今日截止', status: 'pending', end_date: isoDay(0) },
  { task_id: 'T3', name: '提前3天', status: 'pending', end_date: isoDay(3) },
  { task_id: 'T4', name: '远期不应发', status: 'pending', end_date: isoDay(10) },
  { task_id: 'T5', name: '已完成', status: 'completed', end_date: isoDay(-1) },
  { task_id: 'T6', name: '无截止日', status: 'pending', end_date: null },
];

/* ----------------------------- 主流程 ----------------------------- */
(async () => {
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const AUTH = { Authorization: 'Bearer test-secret' };

  console.log('\n[1] 鉴权');
  resetState({ tasks: dueTasks() });
  let r = await request(port, 'GET', '/api/cron/reminders');
  check('无 Authorization 头 → 401', r.status === 401, r.status);
  r = await request(port, 'GET', '/api/cron/reminders', { Authorization: 'Bearer wrong' });
  check('错误 secret → 401', r.status === 401, r.status);
  r = await request(port, 'GET', '/api/cron/reminders', { Authorization: 'bearer test-secret' }); // 小写
  check('小写 bearer 前缀 → 401（严格比对，防绕过）', r.status === 401, r.status);
  r = await request(port, 'GET', '/api/cron/reminders', { Authorization: 'Bearer test-secretX' }); // 额外字符
  check('密钥尾部多字符 → 401（严格比对，防绕过）', r.status === 401, r.status);
  r = await request(port, 'GET', '/api/cron/reminders?secret=test-secret');
  check('保留的 ?secret= 手动入口 → 200', r.status === 200, r.status);
  r = await request(port, 'GET', '/api/cron/reminders?secret=wrong');
  check('?secret= 错误 → 401', r.status === 401, r.status);

  console.log('\n[2] 提醒总开关门（reminder_enabled=false）');
  resetState({ tasks: dueTasks(), cfg: { enabled: false, hour: beijingHour(), minute: 0, leadDays: [1, 3, 7] } });
  r = await request(port, 'GET', '/api/cron/reminders', AUTH);
  check('未启用提醒 → 跳过且不发送', r.body.skipped === true && emailCalls.length === 0, r.body);

  console.log('\n[3] 北京时间小时门（hour 不匹配 → 绝不发送）');
  resetState({ tasks: dueTasks(), cfg: { enabled: true, hour: (beijingHour() + 1) % 24, minute: 0, leadDays: [1, 3, 7] } });
  r = await request(port, 'GET', '/api/cron/reminders', AUTH);
  check('配置 hour 与当前北京小时不一致 → 跳过', r.body.skipped === true && /未到/.test(r.body.reason || ''), r.body);
  check('小时门未命中时一封都没发（关键：不能误发）', emailCalls.length === 0, emailCalls.length);

  console.log('\n[4] 邮件总开关门（email_config.enabled=0）');
  resetState({ tasks: dueTasks(), emailEnabled: 0, cfg: { enabled: true, hour: beijingHour(), minute: 0, leadDays: [1, 3, 7] } });
  r = await request(port, 'GET', '/api/cron/reminders', AUTH);
  check('邮件未启用 → 跳过且不发送', r.body.skipped === true && emailCalls.length === 0, r.body);

  console.log('\n[5] 正常发送：仅临期+逾期，排除已完成/远期/无截止日');
  resetState({ tasks: dueTasks(), cfg: { enabled: true, hour: beijingHour(), minute: 0, leadDays: [1, 3, 7] } });
  r = await request(port, 'GET', '/api/cron/reminders', AUTH);
  check('HTTP 200 且 success=true', r.status === 200 && r.body.success === true, r.body);
  check('发送数量 = 3（T1逾期 / T2今日 / T3提前3天）', r.body.sent === 3, r.body);
  check('逾期数量 = 1（T1）', r.body.overdue === 1, r.body);
  check('实际发出邮件 = 3 封', emailCalls.length === 3, emailCalls.length);
  const sentIds = emailCalls.map(c => c.task_id).sort();
  check('发出的任务为 T1/T2/T3（不含 T4/T5/T6）', JSON.stringify(sentIds) === JSON.stringify(['T1', 'T2', 'T3']), sentIds);
  check('T1 以逾期天数(-3) 传入发送', emailCalls.find(c => c.task_id === 'T1').days === -3, emailCalls);
  check('T3 以提前天数(+3) 传入发送', emailCalls.find(c => c.task_id === 'T3').days === 3, emailCalls);
  // reminders 表应已写入 sent=1 记录（供去重）
  check('reminders 表写入 3 条 sent=1 记录', reminders.filter(x => x.sent === 1).length === 3, reminders);

  console.log('\n[6] 当日去重：同一 UTC 日再次触发（force=false）→ 全跳过');
  r = await request(port, 'GET', '/api/cron/reminders', AUTH);
  check('二次触发 sent=0', r.body.sent === 0, r.body);
  check('二次触发 skipped=3（全部命中当日去重）', r.body.skipped === 3, r.body);
  check('二次触发未重复发送邮件', emailCalls.length === 3, emailCalls.length);

  console.log('\n[7] 强制重发（等同「立即触发一次」force=true 路径）');
  emailCalls = []; // 仅统计本轮
  const fr = await checkAndSendReminders({ includeOverdue: true, force: true });
  check('force 重发 sent=3', fr.sent === 3, fr);
  check('force 重发实际又发出 3 封', emailCalls.length === 3, emailCalls.length);

  console.log('\n[8] vercel.json crons 配置校验');
  const vc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../vercel.json'), 'utf8'));
  check('vercel.json 含 crons 且非空', Array.isArray(vc.crons) && vc.crons.length >= 1, vc.crons);
  check('cron path = /api/cron/reminders', vc.crons[0].path === '/api/cron/reminders', vc.crons[0]);
  check('cron schedule = 0 * * * *（每小时）', vc.crons[0].schedule === '0 * * * *', vc.crons[0].schedule);

  server.close();
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });

/**
 * test-reminder-selection.js
 * 验证提醒筛选规则：定时触发与单次触发都【只发送临期+逾期】任务，绝不全量发送。
 * 通过 mock ./db 与 ./email 注入可控数据，断言 checkAndSendReminders 的选择行为。
 */
const assert = require('assert');
const Module = require('module');
const path = require('path');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '  -> ' + e.message); fail++; }
}

// 供纯函数单测使用（不需要 mock）
const { taskNeedsReminder } = require('../scheduler');

// ---- 1) taskNeedsReminder 纯函数单测 ----
console.log('[A] taskNeedsReminder 纯函数');
check('已逾期(days<0) 默认纳入', () => assert.strictEqual(taskNeedsReminder(-1, [1,3,7], true), true));
check('已逾期 且 includeOverdue=false 不纳入', () => assert.strictEqual(taskNeedsReminder(-5, [1,3,7], false), false));
check('今日截止(days=0) 纳入', () => assert.strictEqual(taskNeedsReminder(0, [1,3,7], true), true));
check('落在提前天数内(如3) 纳入', () => assert.strictEqual(taskNeedsReminder(3, [1,3,7], true), true));
check('落在提前天数内(如7) 纳入', () => assert.strictEqual(taskNeedsReminder(7, [1,3,7], true), true));
check('未到期且不在提前天数内(如10) 不纳入', () => assert.strictEqual(taskNeedsReminder(10, [1,3,7], true), false));
check('未到期且不在提前天数内(如15) 不纳入', () => assert.strictEqual(taskNeedsReminder(15, [1,3,7], true), false));
check('days=null 不纳入', () => assert.strictEqual(taskNeedsReminder(null, [1,3,7], true), false));

// ---- 2) checkAndSendReminders 集成测试（mock db/email） ----
function dateStr(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  // 用本地日历分量构造 YYYY-MM-DD，与 getDaysUntil 的本地零点计算保持一致，避免时区错位
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 候选任务：覆盖 逾期/今日/各提前天数/超出提前天数/已完成
const TASKS = [
  { task_id: 'T_OVERDUE', name: '逾期任务',        end_date: dateStr(-3), status: 'inprogress' },
  { task_id: 'T_TODAY',   name: '今日截止',        end_date: dateStr(0),  status: 'inprogress' },
  { task_id: 'T_D1',      name: '提前1天',         end_date: dateStr(1),  status: 'inprogress' },
  { task_id: 'T_D3',      name: '提前3天',         end_date: dateStr(3),  status: 'inprogress' },
  { task_id: 'T_D7',      name: '提前7天',         end_date: dateStr(7),  status: 'inprogress' },
  { task_id: 'T_D10',     name: '提前10天(超范围)', end_date: dateStr(10), status: 'inprogress' },
  { task_id: 'T_D15',     name: '提前15天(超范围)', end_date: dateStr(15), status: 'inprogress' },
  { task_id: 'T_DONE',    name: '已完成',          end_date: dateStr(2),  status: 'completed' },
];

// 期望被发送的任务（临期+逾期，排除超范围 T_D10/T_D15 与已完成 T_DONE）
const EXPECTED = new Set(['T_OVERDUE', 'T_TODAY', 'T_D1', 'T_D3', 'T_D7']);

function makeMocks(sentRows) {
  const sentCalls = [];
  const db = {
    prepare(sql) {
      return {
        get(...args) {
          if (/email_config/.test(sql)) return { enabled: 1 };
          if (/FROM reminders/.test(sql) && /sent = 1/.test(sql)) {
            const taskId = args[0];
            return sentRows[taskId] ? { id: sentRows[taskId] } : null;
          }
          return null;
        },
        all(...args) {
          if (/FROM tasks/.test(sql)) {
            // 忠实模拟 SQL 过滤：未完成 + 有截止日期
            return TASKS.filter(t => t.status !== 'completed' && !!t.end_date);
          }
          return [];
        },
        run(...args) { return { changes: 1 }; }
      };
    }
  };
  const getReminderSettings = async () => ({ enabled: true, hour: 20, minute: 0, leadDays: [1, 3, 7] });
  const sendTaskReminder = async (task, days) => { sentCalls.push({ task_id: task.task_id, days }); return { sent: true }; };
  return { db, getReminderSettings, sendTaskReminder, sentCalls };
}

const origLoad = Module._load;
// 每次场景重新加载 scheduler.js，使其内部的 require('./db')/require('./email') 命中当前 mock
function loadSchedulerWith(mocks) {
  Module._load = function (request, parent, isMain) {
    if (request === './db') return { db: mocks.db, getReminderSettings: mocks.getReminderSettings };
    if (request === './email') return { sendTaskReminder: mocks.sendTaskReminder };
    return origLoad.apply(this, arguments);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('scheduler.js') || k.endsWith('db.js') || k.endsWith('email.js')) delete require.cache[k];
  }
  return require(path.resolve(__dirname, '../scheduler.js'));
}
function resetLoad() { Module._load = origLoad; }

console.log('[B] 定时触发(尊重去重)：只发临期+逾期，绝不全量');
{
  const mocks = makeMocks({});
  const scheduler = loadSchedulerWith(mocks);
  (async () => {
    const r = await scheduler.checkAndSendReminders({ includeOverdue: true });
    resetLoad();
    const sent = new Set(mocks.sentCalls.map(c => c.task_id));
    check('发送数量=5(逾期1+今日1+提前3)', () => assert.strictEqual(sent.size, 5));
    check('发送集合恰为 临期+逾期', () => assert.deepStrictEqual(sent, EXPECTED));
    check('绝不发送超范围任务 T_D10', () => assert.ok(!sent.has('T_D10')));
    check('绝不发送超范围任务 T_D15', () => assert.ok(!sent.has('T_D15')));
    check('绝不发送已完成任务 T_DONE', () => assert.ok(!sent.has('T_DONE')));
    check('返回值 sent=5', () => assert.strictEqual(r.sent, 5));
    runC();
  })();
}

function runC() {
  console.log('[C] 单次触发(force 绕过去重)：筛选范围与定时完全一致，仍只发临期+逾期');
  {
    const mocks = makeMocks({});
    const scheduler = loadSchedulerWith(mocks);
    (async () => {
      const r = await scheduler.checkAndSendReminders({ includeOverdue: true, force: true });
      resetLoad();
      const sent = new Set(mocks.sentCalls.map(c => c.task_id));
      check('单次触发发送集合与定时完全相同(=临期+逾期)', () => assert.deepStrictEqual(sent, EXPECTED));
      check('单次触发同样不发送超范围任务', () => assert.ok(!sent.has('T_D10') && !sent.has('T_D15')));
      check('单次触发返回值 sent=5', () => assert.strictEqual(r.sent, 5));
      runD();
    })();
  }
}

function runD() {
  console.log('[D] force 仅影响去重、不影响选择：已发过的超范围任务仍不会被补发');
  {
    // 预置 T_OVERDUE / T_TODAY 当日已发送；T_D10/T_D15 未发
    const mocks = makeMocks({ T_OVERDUE: 1, T_TODAY: 1 });
    const scheduler = loadSchedulerWith(mocks);
    (async () => {
      // 定时(尊重去重)：应跳过已发的2个，仅发 提前1/3/7 => 3封
      const rScheduled = await scheduler.checkAndSendReminders({ includeOverdue: true });
      resetLoad();
      const sentScheduled = new Set(mocks.sentCalls.map(c => c.task_id));
      check('定时尊重去重：已发的逾期/今日被跳过，仅发3封', () => assert.strictEqual(sentScheduled.size, 3));
      check('定时跳过已发后仍不含超范围', () => assert.ok(!sentScheduled.has('T_D10') && !sentScheduled.has('T_D15')));

      // 单次(force)：绕过当日去重，重发已发的2个 + 提前1/3/7 => 5封，超范围依旧不发
      const mocks2 = makeMocks({ T_OVERDUE: 1, T_TODAY: 1 });
      const scheduler2 = loadSchedulerWith(mocks2);
      const rForce = await scheduler2.checkAndSendReminders({ includeOverdue: true, force: true });
      resetLoad();
      const sentForce = new Set(mocks2.sentCalls.map(c => c.task_id));
      check('单次force重发已发+临期，共5封', () => assert.strictEqual(sentForce.size, 5));
      check('单次force与定时筛选范围一致(均不含超范围)', () =>
        assert.deepStrictEqual(sentForce, new Set(['T_OVERDUE', 'T_TODAY', 'T_D1', 'T_D3', 'T_D7'])));
      check('force 绝不补发超范围任务 T_D10/T_D15', () => assert.ok(!sentForce.has('T_D10') && !sentForce.has('T_D15')));

      console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
      process.exit(fail ? 1 : 0);
    })();
  }
}

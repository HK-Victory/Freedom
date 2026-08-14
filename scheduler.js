/**
 * scheduler.js — 任务倒计时提醒逻辑
 *
 * 说明：Vercel 免费(serverless) 环境没有常驻进程，因此不再使用 node-cron 常驻调度，
 * 而是：
 *   - 本地运行：server.js 用 setInterval 每 12 小时触发一次；
 *   - Vercel 环境：由 Vercel Cron（vercel.json 的 crons）每日 20:00（北京）请求 /api/cron/reminders 触发。
 * 两种环境都调用这里的 checkAndSendReminders()。
 */
const { db, getReminderSettings } = require('./db');
const { sendTaskReminder } = require('./email');
const { logSystem } = require('./lib/audit');

function getDaysUntil(endDateStr) {
  if (!endDateStr) return null;
  // 以 UTC 日历日为单位做差，完全不依赖运行时本地时区，避免 serverless 环境
  // （Vercel 为 UTC）与本地开发（如 Asia/Shanghai）算出相差 1 天的边界问题。
  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let endUTC;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(endDateStr).trim());
  if (m) {
    // "YYYY-MM-DD" 当作 UTC 当日零点
    endUTC = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  } else {
    const t = new Date(endDateStr).getTime();
    if (isNaN(t)) return null;
    endUTC = t;
  }
  return Math.round((endUTC - todayUTC) / (1000 * 60 * 60 * 24));
}

// 是否需要发送提醒：仅「临期」与「已逾期」任务，绝不全量。
// - 已逾期 (days < 0)：纳入（除非 includeOverdue=false）
// - 今日截止 (days === 0)：纳入（临期边界）
// - 其余未到期：仅当剩余天数落在页面配置的提前提醒天数内
// 该函数是「定时触发」与「单次触发」共用的唯一筛选规则。
function taskNeedsReminder(days, leadDays, includeOverdue = true) {
  if (days === null) return false;
  if (days < 0) return !!includeOverdue;
  if (days === 0) return true;
  return Array.isArray(leadDays) && leadDays.includes(days);
}

async function checkAndSendReminders(options = {}) {
  // includeOverdue: 是否对「已过期」任务也发送提醒（默认开启）
  // force: 是否忽略当日已发送去重（手动「立即触发」用，确保点击即重发；但与定时任务
  //        采用完全相同的「临期+逾期」筛选规则，绝不因单次触发而全量发送）
  // 注意：定时触发与单次触发使用同一套任务筛选（仅「临期」与「已逾期」才发送），
  //       区别只在于 force 是否绕过当日去重。
  const { includeOverdue = true, force = false } = options;
  console.log(`[${new Date().toLocaleString('zh-CN')}] 开始检查任务倒计时提醒...`);

  const startedAt = Date.now();
  const cfg = await db.prepare('SELECT enabled FROM email_config WHERE id = 1').get();
  if (!cfg || !cfg.enabled) {
    console.log('  邮件提醒未启用，跳过');
    await logSystem({
      category: 'reminder', action: 'skip', status: 'success',
      summary: '提醒任务跳过执行：邮件功能未启用',
      duration_ms: Date.now() - startedAt,
    });
    return { skipped: true, reason: '邮件提醒未启用（请在「系统设置-邮件配置」中启用并配置SMTP）' };
  }

  // 页面配置的「提前提醒天数」（如 [1,3,7]），仅在这些剩余天数发送
  const settings = await getReminderSettings();
  const leadDays = settings.leadDays || [1, 3, 7];

  const tasks = await db.prepare(`
    SELECT * FROM tasks
    WHERE status != 'completed'
      AND end_date IS NOT NULL
      AND end_date != ''
  `).all();

  let sentCount = 0;
  let skipCount = 0;       // 当日已发送（去重）而跳过的条数
  let overdueCount = 0;
  let notNeededCount = 0;  // 有截止日但不在「临期/逾期」窗口内（含已完成）的条数

  // 阶段一：判定需提醒的任务并预写 reminders 记录（快，串行）
  const today = new Date().toISOString().split('T')[0];
  const targets = [];
  for (const task of tasks) {
    const days = getDaysUntil(task.end_date);
    if (days === null) continue;

    // 只发送「临期」（今日截止或落在配置的提前天数内）与「已逾期」任务，绝不全量发送。
    // 定时触发与单次触发共用该规则，区别在于 force 是否绕过当日去重。
    if (!taskNeedsReminder(days, leadDays, includeOverdue)) {
      notNeededCount++;
      continue;
    }

    const alreadySent = await db.prepare(`
      SELECT id FROM reminders
      WHERE task_id = ? AND reminder_date = ? AND sent = 1
    `).get(task.task_id, today);

    // 定时触发尊重当日去重；单次「立即触发」(force) 绕过去重，确保点击即重发（仍仅限临期+逾期）
    if (!force && alreadySent) {
      skipCount++;
      console.log(`  ⏭️  ${task.task_id} ${task.name} - 今日已发送，跳过（去重；如需重发用 ?force=1）`);
      continue;
    }

    if (alreadySent) {
      // force 模式下复用当日记录，置回待发送，避免重复插入多行
      await db.prepare(`UPDATE reminders SET sent = 0 WHERE id = ?`).run(alreadySent.id);
    } else {
      await db.prepare(`
        INSERT INTO reminders (task_id, reminder_date, days_before, sent)
        VALUES (?, ?, ?, 0)
      `).run(task.task_id, today, days);
    }

    targets.push({ task, days });
  }

  // 阶段二：有限并发发送（默认 5 路），缩短整体耗时，避免单请求超时
  const CONCURRENCY = 5;
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const i = cursor++;
      const { task, days } = targets[i];
      try {
        const result = await sendTaskReminder(task, days);
        if (result.sent) {
          await db.prepare(`UPDATE reminders SET sent = 1, sent_at = datetime('now','localtime') WHERE task_id = ? AND reminder_date = ?`)
            .run(task.task_id, today);
          sentCount++;
          if (days < 0) overdueCount++;
          const label = days < 0 ? `逾期${-days}天` : (days === 0 ? '今日截止' : `倒计时${days}天`);
          console.log(`  ✅ ${task.task_id} ${task.name} - ${label}提醒已发送`);
        } else {
          console.log(`  ⏭️  ${task.task_id} ${task.name} - 跳过: ${result.reason}`);
          await logSystem({
            category: 'reminder', action: 'send', status: 'failure',
            target_type: 'task', target_id: task.task_id,
            summary: `提醒邮件未发出（${task.name}）：${result.reason || '未知原因'}`,
            detail: { days, reason: result.reason },
          });
        }
      } catch (err) {
        console.error(`  ❌ ${task.task_id} ${task.name} - 发送失败: ${err.message}`);
        await logSystem({
          category: 'reminder', action: 'send', status: 'failure',
          target_type: 'task', target_id: task.task_id,
          summary: `提醒邮件发送异常（${task.name}）：${err.message}`,
          detail: { days, error: err.message },
        });
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(workers);

  console.log(`  完成: 发送${sentCount}封（其中逾期${overdueCount}封）, 今日已发送跳过${skipCount}条, 不在提醒窗口${notNeededCount}条`);

  // 定时任务「执行日志」：把本次执行的实际结果落库，供审计页复盘
  //（例如「为什么今天没收到提醒」——一看就知道是当日去重、还是不在提醒窗口、还是发送失败）
  await logSystem({
    category: 'reminder', action: 'execute', status: 'success',
    summary: `提醒任务执行完成：发送 ${sentCount} 封（逾期 ${overdueCount} 封），今日已发送跳过 ${skipCount} 条，不在提醒窗口 ${notNeededCount} 条`,
    detail: { sent: sentCount, overdue: overdueCount, skipped: skipCount, notNeeded: notNeededCount, leadDays, force, includeOverdue },
    duration_ms: Date.now() - startedAt,
  });

  return { sent: sentCount, skipped: skipCount, overdue: overdueCount, notNeeded: notNeededCount };
}

module.exports = { checkAndSendReminders, getDaysUntil, taskNeedsReminder };

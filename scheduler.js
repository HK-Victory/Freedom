/**
 * scheduler.js — 任务倒计时提醒逻辑
 *
 * 说明：Vercel 免费(serverless) 环境没有常驻进程，因此不再使用 node-cron 常驻调度，
 * 而是：
 *   - 本地运行：server.js 用 setInterval 每 12 小时触发一次；
 *   - Vercel 环境：由 GitHub Actions 定时工作流（每小时）请求 /api/cron/reminders 触发。
 * 两种环境都调用这里的 checkAndSendReminders()。
 */
const { db, getReminderSettings } = require('./db');
const { sendTaskReminder } = require('./email');

function getDaysUntil(endDateStr) {
  if (!endDateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(endDateStr);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - today) / (1000 * 60 * 60 * 24));
}

async function checkAndSendReminders(options = {}) {
  // includeOverdue: 是否对「已过期」任务也发送提醒（默认开启）
  // strictLeadDays: 是否严格只按页面配置的提前天数发送（手动触发可放宽）
  // force: 是否忽略当日已发送去重（手动「立即触发」用，确保点击即重发，含逾期）
  const { includeOverdue = true, strictLeadDays = false, force = false } = options;
  console.log(`[${new Date().toLocaleString('zh-CN')}] 开始检查任务倒计时提醒...`);

  const cfg = db.prepare('SELECT enabled FROM email_config WHERE id = 1').get();
  if (!cfg || !cfg.enabled) {
    console.log('  邮件提醒未启用，跳过');
    return { skipped: true, reason: '邮件提醒未启用（请在「系统设置-邮件配置」中启用并配置SMTP）' };
  }

  // 页面配置的「提前提醒天数」（如 [1,3,7]），仅在这些剩余天数发送
  const settings = getReminderSettings();
  const leadDays = settings.leadDays || [1, 3, 7];

  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status != 'completed'
      AND end_date IS NOT NULL
      AND end_date != ''
  `).all();

  let sentCount = 0;
  let skipCount = 0;
  let overdueCount = 0;

  // 阶段一：判定需提醒的任务并预写 reminders 记录（快，串行）
  const today = new Date().toISOString().split('T')[0];
  const targets = [];
  for (const task of tasks) {
    const days = getDaysUntil(task.end_date);
    if (days === null) continue;

    // 判定该任务是否需要发送提醒
    let shouldRemind = false;
    if (days < 0) {
      shouldRemind = includeOverdue;              // 已过期任务：默认纳入提醒
    } else if (days === 0) {
      shouldRemind = true;                        // 截止当天：必提醒
    } else if (strictLeadDays) {
      shouldRemind = leadDays.includes(days);     // 定时任务：仅按配置的提前天数
    } else {
      shouldRemind = true;                        // 手动触发：放宽，所有未过期且未提醒过的都发
    }
    if (!shouldRemind) continue;

    const alreadySent = db.prepare(`
      SELECT id FROM reminders
      WHERE task_id = ? AND reminder_date = ? AND sent = 1
    `).get(task.task_id, today);

    // 手动「立即触发」(force) 时忽略当日去重，强制重新发送（含逾期），确保点击即生效
    if (!force && alreadySent) {
      skipCount++;
      continue;
    }

    db.prepare(`
      INSERT INTO reminders (task_id, reminder_date, days_before, sent)
      VALUES (?, ?, ?, 0)
    `).run(task.task_id, today, days);

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
          db.prepare(`UPDATE reminders SET sent = 1, sent_at = datetime('now','localtime') WHERE task_id = ? AND reminder_date = ?`)
            .run(task.task_id, today);
          sentCount++;
          if (days < 0) overdueCount++;
          const label = days < 0 ? `逾期${-days}天` : (days === 0 ? '今日截止' : `倒计时${days}天`);
          console.log(`  ✅ ${task.task_id} ${task.name} - ${label}提醒已发送`);
        } else {
          console.log(`  ⏭️  ${task.task_id} ${task.name} - 跳过: ${result.reason}`);
        }
      } catch (err) {
        console.error(`  ❌ ${task.task_id} ${task.name} - 发送失败: ${err.message}`);
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker());
  await Promise.all(workers);

  console.log(`  完成: 发送${sentCount}封（其中逾期${overdueCount}封）, 跳过${skipCount}条, 无需发送${targets.length}条`);
  return { sent: sentCount, skipped: skipCount, overdue: overdueCount };
}

module.exports = { checkAndSendReminders, getDaysUntil };

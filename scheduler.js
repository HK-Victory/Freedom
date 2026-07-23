/**
 * scheduler.js — 任务倒计时提醒逻辑
 *
 * 说明：Vercel 免费(serverless) 环境没有常驻进程，因此不再使用 node-cron 常驻调度，
 * 而是：
 *   - 本地运行：server.js 用 setInterval 每 12 小时触发一次；
 *   - Vercel 环境：由 vercel.json 的 crons 定时请求 /api/cron/reminders 触发。
 * 两种环境都调用这里的 checkAndSendReminders()。
 */
const { db } = require('./db');
const { sendTaskReminder } = require('./email');

function getDaysUntil(endDateStr) {
  if (!endDateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = new Date(endDateStr);
  end.setHours(0, 0, 0, 0);
  return Math.round((end - today) / (1000 * 60 * 60 * 24));
}

async function checkAndSendReminders() {
  console.log(`[${new Date().toLocaleString('zh-CN')}] 开始检查任务倒计时提醒...`);

  const cfg = db.prepare('SELECT enabled FROM email_config WHERE id = 1').get();
  if (!cfg || !cfg.enabled) {
    console.log('  邮件提醒未启用，跳过');
    return { skipped: true, reason: '邮件提醒未启用' };
  }

  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status != 'completed'
      AND end_date IS NOT NULL
      AND end_date != ''
  `).all();

  let sentCount = 0;
  let skipCount = 0;

  for (const task of tasks) {
    const days = getDaysUntil(task.end_date);
    if (days === null) continue;
    if (days < 0 || days > 7) continue;

    const today = new Date().toISOString().split('T')[0];
    const alreadySent = db.prepare(`
      SELECT id FROM reminders
      WHERE task_id = ? AND reminder_date = ? AND sent = 1
    `).get(task.task_id, today);

    if (alreadySent) {
      skipCount++;
      continue;
    }

    db.prepare(`
      INSERT INTO reminders (task_id, reminder_date, days_before, sent)
      VALUES (?, ?, ?, 0)
    `).run(task.task_id, today, days);

    try {
      const result = await sendTaskReminder(task, days);
      if (result.sent) {
        db.prepare(`UPDATE reminders SET sent = 1, sent_at = datetime('now','localtime') WHERE task_id = ? AND reminder_date = ?`)
          .run(task.task_id, today);
        sentCount++;
        console.log(`  ✅ ${task.task_id} ${task.name} - 倒计时${days}天提醒已发送`);
      } else {
        console.log(`  ⏭️  ${task.task_id} ${task.name} - 跳过: ${result.reason}`);
      }
    } catch (err) {
      console.error(`  ❌ ${task.task_id} ${task.name} - 发送失败: ${err.message}`);
    }
  }

  console.log(`  完成: 发送${sentCount}封, 跳过${skipCount}条`);
  return { sent: sentCount, skipped: skipCount };
}

module.exports = { checkAndSendReminders, getDaysUntil };

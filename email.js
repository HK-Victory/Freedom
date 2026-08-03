const nodemailer = require('nodemailer');
const { db, getEmailConfig } = require('./db');

// 任务详情链接前缀：生产环境通过 APP_URL 环境变量配置（如 https://xxx.vercel.app）
const APP_URL = (process.env.APP_URL || 'https://your-vercel-app.vercel.app').replace(/\/$/, '');

let _transporter = null;
let _transporterKey = '';

// 复用 transporter：避免每封邮件都重建连接；并设连接/握手/套接字超时，
// 让 SMTP 慢或不可达时快速失败，而不是卡到 nodemailer 默认的 30~120 秒。
function getTransporter() {
  const cfg = getEmailConfig();
  if (!cfg.smtp_host || !cfg.smtp_user) return null;

  const key = `${cfg.smtp_host}|${cfg.smtp_port}|${cfg.smtp_secure}|${cfg.smtp_user}`;
  if (_transporter && _transporterKey === key) return _transporter;

  _transporter = nodemailer.createTransport({
    host: cfg.smtp_host,
    port: cfg.smtp_port || 465,
    secure: cfg.smtp_secure === 1,
    auth: {
      user: cfg.smtp_user,
      pass: cfg.smtp_pass
    },
    connectionTimeout: 10000,   // 建立连接最多 10s
    greetingTimeout: 10000,    // SMTP 握手最多 10s
    socketTimeout: 20000       // 读写套接字最多 20s
  });
  _transporterKey = key;
  return _transporter;
}

// 单封邮件发送加硬超时：即使 transporter 层超时未触发，也保证一封卡住不会拖垮整批。
async function sendMailWithTimeout(transporter, mailOptions, ms = 12000) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`SMTP发送超时（${ms}ms）`)), ms);
  });
  try {
    return await Promise.race([transporter.sendMail(mailOptions), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendTestEmail(to) {
  const cfg = getEmailConfig();
  if (!cfg.smtp_host || !cfg.smtp_user) {
    throw new Error('SMTP配置不完整，请先填写SMTP服务器信息');
  }
  const t = getTransporter();
  const info = await sendMailWithTimeout(t, {
    from: `"${cfg.sender_name}" <${cfg.smtp_user}>`,
    to,
    subject: '【闻道任务提醒】测试邮件',
    html: `
      <div style="font-family: 'Microsoft YaHei', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #2563eb;">✅ 邮件提醒配置成功</h2>
        <p>这是一封来自「闻道包装设计工作室任务跟踪系统」的测试邮件。</p>
        <p>如果您收到此邮件，说明SMTP配置正确，系统将按时为您发送任务倒计时提醒。</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
        <p style="color: #6b7280; font-size: 12px;">此邮件由系统自动发送，请勿回复。</p>
      </div>
    `
  });
  return info;
}

function getRecipientsForTask(taskId) {
  const all = db.prepare('SELECT * FROM email_recipients WHERE enabled = 1 AND scope = ?').all('all');
  const specific = db.prepare('SELECT * FROM email_recipients WHERE enabled = 1 AND scope = ?').all('specific');
  const filtered = specific.filter(r => {
    try {
      const ids = JSON.parse(r.task_ids || '[]');
      return ids.includes(taskId);
    } catch { return false; }
  });
  return [...all, ...filtered];
}

async function sendTaskReminder(task, daysBefore) {
  const cfg = getEmailConfig();
  if (!cfg.enabled) return { skipped: true, reason: '邮件提醒未启用' };

  const recipients = getRecipientsForTask(task.task_id);
  if (recipients.length === 0) return { skipped: true, reason: '无收件人' };

  const t = getTransporter();
  if (!t) return { skipped: true, reason: 'SMTP未配置' };

  const priorityColors = { '高': '#dc2626', '中': '#f59e0b', '低': '#10b981' };
  const priorityColor = priorityColors[task.priority] || '#6b7280';

  // 根据剩余天数生成标题与提示文案（支持「逾期 / 今日截止 / 倒计时」三种状态）
  let subject, bannerText, bannerColor, boxBg, boxBorder;
  if (daysBefore < 0) {
    const overdue = -daysBefore;
    subject = `🚨【已逾期${overdue}天】${task.name}`;
    bannerText = `⚠️ 此任务已逾期 ${overdue} 天，请尽快处理！`;
    bannerColor = '#dc2626'; boxBg = '#fef2f2'; boxBorder = '#dc2626';
  } else if (daysBefore === 0) {
    subject = `🚨【今日截止】${task.name}`;
    bannerText = '⚠️ 此任务今日截止！请确保按时完成。';
    bannerColor = '#dc2626'; boxBg = '#fef2f2'; boxBorder = '#dc2626';
  } else {
    subject = `⏰【倒计时${daysBefore}天】${task.name}`;
    bannerText = `⏰ 距截止日期仅剩 ${daysBefore} 天`;
    bannerColor = '#92400e'; boxBg = '#fffbeb'; boxBorder = '#f59e0b';
  }

  const toList = recipients.map(r => r.email).join(', ');

  const html = `
  <div style="font-family: 'Microsoft YaHei', sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; background: #f9fafb;">
    <div style="background: white; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
        <h2 style="margin: 0; color: #1e293b; font-size: 20px;">${task.name}</h2>
        <span style="background: ${priorityColor}; color: white; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600;">${task.priority || '中'}优先级</span>
      </div>
      <div style="background: ${boxBg}; border-left: 4px solid ${boxBorder}; padding: 12px 16px; border-radius: 6px; margin-bottom: 16px;">
        <p style="margin: 0; font-size: 16px; color: ${bannerColor}; font-weight: 600;">
          ${bannerText}
        </p>
        <p style="margin: 4px 0 0; font-size: 13px; color: #6b7280;">截止时间：${task.end_date}</p>
      </div>
      <table style="width: 100%; border-collapse: collapse; margin-bottom: 16px;">
        <tr><td style="padding: 6px 0; color: #6b7280; width: 80px; font-size: 13px;">任务编号</td><td style="padding: 6px 0; font-weight: 600; font-size: 14px;">${task.task_id}</td></tr>
        <tr><td style="padding: 6px 0; color: #6b7280; font-size: 13px;">任务分类</td><td style="padding: 6px 0; font-size: 14px;">${task.category || '-'}</td></tr>
        <tr><td style="padding: 6px 0; color: #6b7280; font-size: 13px;">责任人</td><td style="padding: 6px 0; font-size: 14px;">${task.owner || '-'}</td></tr>
        <tr><td style="padding: 6px 0; color: #6b7280; font-size: 13px;">当前状态</td><td style="padding: 6px 0; font-size: 14px;">${task.status === 'completed' ? '已完成' : task.status === 'in_progress' ? '进行中' : '待开始'}</td></tr>
        <tr><td style="padding: 6px 0; color: #6b7280; font-size: 13px;">前置任务</td><td style="padding: 6px 0; font-size: 14px;">${task.dependency || '无'}</td></tr>
      </table>
      <div style="background: #f3f4f6; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;">
        <p style="margin: 0 0 6px; font-weight: 600; font-size: 13px; color: #374151;">📋 具体要求与验收标准</p>
        <p style="margin: 0; font-size: 13px; color: #6b7280; white-space: pre-wrap; line-height: 1.6;">${task.requirements || '暂无'}</p>
      </div>
      <div style="text-align: center; margin-top: 20px;">
        <a href="${APP_URL}/#/task/${task.task_id}" style="display: inline-block; background: #2563eb; color: white; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600;">查看任务详情与文档</a>
      </div>
    </div>
    <p style="text-align: center; color: #9ca3af; font-size: 11px; margin-top: 16px;">闻道包装设计工作室任务跟踪系统 · 自动发送</p>
  </div>`;

  const info = await sendMailWithTimeout(t, {
    from: `"${cfg.sender_name}" <${cfg.smtp_user}>`,
    to: toList,
    subject,
    html
  });

  const logLabel = daysBefore < 0 ? `逾期${-daysBefore}天` : (daysBefore === 0 ? '今日截止' : `倒计时${daysBefore}天`);
  db.prepare(`INSERT INTO task_logs (task_id, action, content, operator) VALUES (?, ?, ?, ?)`)
    .run(task.task_id, 'email_reminder', `发送${logLabel}提醒邮件至 ${toList}`, '系统');

  return { sent: true, to: toList, messageId: info.messageId };
}

module.exports = { sendTestEmail, sendTaskReminder, getTransporter };

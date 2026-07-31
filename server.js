const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { db, getEmailConfig, upsertEmailConfig, getReminderSettings, setReminderSettings, flush, initDefaultAdmin, getUserByUsername, listUsers, createUser, updateUser, deleteUser, ensureReady } = require('./db');
const { syncExcel, resetAndSync } = require('./excel-reader');
const { sendTestEmail, sendTaskReminder } = require('./email');
const { checkAndSendReminders, getDaysUntil } = require('./scheduler');
const { signToken, requireAuth, optionalAuth, requireAdmin } = require('./auth');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// 写操作（增删改）在返回响应前先 await 落盘，确保部署/重启不丢数据。
// 只读请求（GET）不触发，避免无谓的网络写入延迟。
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return next();
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);
  res.json = function (body) {
    Promise.resolve()
      .then(() => flush())
      .catch((e) => console.error('[flush] 落盘失败:', e.message))
      .finally(() => origJson.call(this, body));
    return res;
  };
  res.send = function (body) {
    Promise.resolve()
      .then(() => flush())
      .catch((e) => console.error('[flush] 落盘失败:', e.message))
      .finally(() => origSend.call(this, body));
    return res;
  };
  next();
});

// ============ 认证 API ============

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

  const user = getUserByUsername(username);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  if (!user.enabled) return res.status(403).json({ error: '账号已被禁用，请联系管理员' });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: '用户名或密码错误' });

  const token = signToken(user);
  res.json({
    success: true,
    token,
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role }
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: '旧密码和新密码不能为空' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密码至少6位' });

  const user = getUserByUsername(req.user.username);
  if (!bcrypt.compareSync(old_password, user.password_hash)) {
    return res.status(400).json({ error: '旧密码错误' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  updateUser(req.user.id, { password_hash: hash });
  res.json({ success: true, message: '密码修改成功' });
});

// 文件上传配置
const upload = multer({
  dest: path.join(__dirname, 'data', 'uploads'),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ============ 任务 API ============

app.get('/api/tasks', requireAuth, (req, res) => {
  const { status, category } = req.query;
  let sql = 'SELECT * FROM tasks';
  const conditions = [];
  const params = {};
  if (status) { conditions.push('status = @status'); params.status = status; }
  if (category) { conditions.push('category = @category'); params.category = category; }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY end_date ASC';
  const tasks = db.prepare(sql).all(params);
  tasks.forEach(t => {
    t.days_left = getDaysUntil(t.end_date);
  });
  res.json(tasks);
});

app.get('/api/tasks/:id', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  task.days_left = getDaysUntil(task.end_date);

  const doc = db.prepare('SELECT * FROM documents WHERE task_id = ?').get(req.params.id);
  task.document = doc ? doc.content : '';

  const logs = db.prepare('SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
  task.logs = logs;

  const progress = db.prepare('SELECT * FROM task_progress WHERE task_id = ? ORDER BY recorded_at DESC').all(req.params.id);
  task.progress_history = progress;

  res.json(task);
});

app.put('/api/tasks/:id/status', requireAuth, (req, res) => {
  const { status } = req.body;
  const valid = ['pending', 'in_progress', 'completed', 'overdue'];
  if (!valid.includes(status)) return res.status(400).json({ error: '无效状态' });
  db.prepare('UPDATE tasks SET status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE task_id = ?')
    .run(status, req.params.id);
  db.prepare('INSERT INTO task_logs (task_id, action, content, operator) VALUES (?, ?, ?, ?)')
    .run(req.params.id, 'status_change', `状态变更为: ${status}`, req.body.operator || '用户');
  res.json({ success: true });
});

app.put('/api/tasks/:id/progress', requireAuth, (req, res) => {
  const { progress, note } = req.body;
  db.prepare('INSERT INTO task_progress (task_id, progress, note) VALUES (?, ?, ?)')
    .run(req.params.id, progress, note || '');
  if (progress >= 100) {
    db.prepare('UPDATE tasks SET status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE task_id = ?')
      .run('completed', req.params.id);
  } else if (progress > 0) {
    db.prepare('UPDATE tasks SET status = ?, updated_at = datetime(\'now\',\'localtime\') WHERE task_id = ?')
      .run('in_progress', req.params.id);
  }
  res.json({ success: true });
});

// ---- 创建新任务 ----
app.post('/api/tasks', requireAuth, (req, res) => {
  const { task_id, category, name, requirements, priority, start_date, end_date, owner, resources, dependency, status } = req.body;
  if (!task_id || !name) return res.status(400).json({ error: '任务ID和任务名称不能为空' });

  const existing = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(task_id);
  if (existing) return res.status(400).json({ error: '任务ID已存在' });

  db.prepare(`
    INSERT INTO tasks (task_id, category, name, requirements, priority, start_date, end_date, owner, resources, dependency, sheet_name, status)
    VALUES (@task_id, @category, @name, @requirements, @priority, @start_date, @end_date, @owner, @resources, @dependency, @sheet_name, @status)
  `).run({
    task_id,
    category: category || '',
    name,
    requirements: requirements || '',
    priority: priority || '中',
    start_date: start_date || null,
    end_date: end_date || null,
    owner: owner || '',
    resources: resources || '',
    dependency: dependency || '',
    sheet_name: '手动创建',
    status: status || 'pending'
  });

  // 创建空文档
  db.prepare('INSERT OR IGNORE INTO documents (task_id, content) VALUES (?, ?)').run(task_id, '');

  db.prepare('INSERT INTO task_logs (task_id, action, content, operator) VALUES (?, ?, ?, ?)')
    .run(task_id, 'create', '手动创建任务', req.body.operator || '用户');

  res.json({ success: true, task_id });
});

// ---- 编辑任务（全字段更新）----
app.put('/api/tasks/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '任务不存在' });

  const { category, name, requirements, priority, start_date, end_date, owner, resources, dependency, status } = req.body;

  db.prepare(`
    UPDATE tasks SET
      category = COALESCE(@category, category),
      name = COALESCE(@name, name),
      requirements = COALESCE(@requirements, requirements),
      priority = COALESCE(@priority, priority),
      start_date = COALESCE(@start_date, start_date),
      end_date = COALESCE(@end_date, end_date),
      owner = COALESCE(@owner, owner),
      resources = COALESCE(@resources, resources),
      dependency = COALESCE(@dependency, dependency),
      status = COALESCE(@status, status),
      updated_at = datetime('now','localtime')
    WHERE task_id = @task_id
  `).run({
    task_id: id,
    category: category !== undefined ? category : null,
    name: name !== undefined ? name : null,
    requirements: requirements !== undefined ? requirements : null,
    priority: priority !== undefined ? priority : null,
    start_date: start_date !== undefined ? start_date : null,
    end_date: end_date !== undefined ? end_date : null,
    owner: owner !== undefined ? owner : null,
    resources: resources !== undefined ? resources : null,
    dependency: dependency !== undefined ? dependency : null,
    status: status !== undefined ? status : null
  });

  db.prepare('INSERT INTO task_logs (task_id, action, content, operator) VALUES (?, ?, ?, ?)')
    .run(id, 'edit', '编辑任务信息', req.body.operator || '用户');

  res.json({ success: true });
});

// ---- 删除任务 ----
app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const existing = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '任务不存在' });

  db.prepare('DELETE FROM task_progress WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM task_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM documents WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM reminders WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE task_id = ?').run(id);

  res.json({ success: true });
});

// ============ 文档 API ============

app.get('/api/tasks/:id/document', requireAuth, (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE task_id = ?').get(req.params.id);
  if (!doc) return res.json({ content: '', updated_at: '', updated_by: '' });
  res.json(doc);
});

app.put('/api/tasks/:id/document', requireAuth, (req, res) => {
  const { content, updated_by } = req.body;
  db.prepare(`
    INSERT INTO documents (task_id, content, updated_at, updated_by)
    VALUES (?, ?, datetime('now','localtime'), ?)
    ON CONFLICT(task_id) DO UPDATE SET
      content = ?, updated_at = datetime('now','localtime'), updated_by = ?
  `).run(req.params.id, content, updated_by || '匿名用户', content, updated_by || '匿名用户');

  db.prepare('INSERT INTO task_logs (task_id, action, content, operator) VALUES (?, ?, ?, ?)')
    .run(req.params.id, 'document_edit', '更新任务文档', updated_by || '匿名用户');

  res.json({ success: true, updated_at: new Date().toLocaleString('zh-CN') });
});

// ============ 邮件配置 API ============

app.get('/api/email/config', requireAuth, (req, res) => {
  const cfg = getEmailConfig();
  // 不返回密码明文
  res.json({
    ...cfg,
    smtp_pass: cfg.smtp_pass ? '******' : ''
  });
});

app.post('/api/email/config', requireAuth, (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, sender_name, enabled } = req.body;
  const existing = getEmailConfig();
  const finalPass = (smtp_pass === '******' || !smtp_pass) ? existing.smtp_pass : smtp_pass;
  upsertEmailConfig({
    smtp_host: smtp_host || '',
    smtp_port: smtp_port || 465,
    smtp_user: smtp_user || '',
    smtp_pass: finalPass,
    smtp_secure: smtp_secure !== undefined ? (smtp_secure ? 1 : 0) : 1,
    sender_name: sender_name || '闻道任务提醒',
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : 0
  });
  res.json({ success: true });
});

app.post('/api/email/test', requireAuth, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: '请提供收件邮箱' });
    const info = await sendTestEmail(to);
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ 收件人 API ============

app.get('/api/email/recipients', requireAuth, (req, res) => {
  const recipients = db.prepare('SELECT * FROM email_recipients ORDER BY created_at DESC').all();
  res.json(recipients);
});

app.post('/api/email/recipients', requireAuth, (req, res) => {
  const { email, name, scope, task_ids } = req.body;
  if (!email) return res.status(400).json({ error: '邮箱不能为空' });
  const existing = db.prepare('SELECT id FROM email_recipients WHERE email = ?').get(email);
  if (existing) return res.status(400).json({ error: '该邮箱已存在' });
  db.prepare('INSERT INTO email_recipients (email, name, scope, task_ids) VALUES (?, ?, ?, ?)')
    .run(email, name || '', scope || 'all', JSON.stringify(task_ids || []));
  res.json({ success: true });
});

app.delete('/api/email/recipients/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM email_recipients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.put('/api/email/recipients/:id', requireAuth, (req, res) => {
  const { email, name, scope, task_ids, enabled } = req.body;
  db.prepare('UPDATE email_recipients SET email=?, name=?, scope=?, task_ids=?, enabled=? WHERE id=?')
    .run(email, name || '', scope || 'all', JSON.stringify(task_ids || []), enabled !== undefined ? (enabled ? 1 : 0) : 1, req.params.id);
  res.json({ success: true });
});

// ============ 提醒设置 API（页面可配置定时发送时间 / 提前提醒天数）============

app.get('/api/settings/reminder', requireAuth, requireAdmin, (req, res) => {
  res.json(getReminderSettings());
});

app.put('/api/settings/reminder', requireAuth, requireAdmin, (req, res) => {
  try {
    setReminderSettings(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ Excel 同步 API ============

app.post('/api/sync', requireAuth, requireAdmin, (req, res) => {
  try {
    const { filePath, reset } = req.body;
    const targetPath = filePath || path.join(__dirname, 'data', '闻道包装设计工作室计划书.xlsx');
    const result = reset ? resetAndSync(targetPath) : syncExcel(targetPath);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- 上传Excel文件并重置导入 ----
app.post('/api/import-excel', requireAuth, requireAdmin, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传Excel文件' });
    const uploadedPath = req.file.path;

    // 同时复制一份到 data 目录作为备份
    const backupPath = path.join(__dirname, 'data', '闻道包装设计工作室计划书.xlsx');
    try { fs.copyFileSync(uploadedPath, backupPath); } catch (e) { /* 忽略复制错误 */ }

    const result = resetAndSync(uploadedPath);

    // 清理临时文件
    try { fs.unlinkSync(uploadedPath); } catch (e) { /* 忽略 */ }

    res.json({ success: true, ...result, message: `导入完成：${result.tasks}项任务, ${result.milestones}个里程碑, ${result.risks}个风险` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ 手动触发提醒 API ============

app.post('/api/reminders/trigger', requireAuth, requireAdmin, async (req, res) => {
  try {
    await checkAndSendReminders();
    res.json({ success: true, message: '提醒检查已执行' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reminders', requireAuth, (req, res) => {
  const { days } = req.query;
  let sql = `SELECT r.*, t.name as task_name, t.end_date, t.owner
    FROM reminders r JOIN tasks t ON r.task_id = t.task_id`;
  if (days) sql += ` WHERE r.reminder_date >= date('now','localtime','-' || ? || ' days')`;
  sql += ' ORDER BY r.reminder_date DESC';
  const reminders = days ? db.prepare(sql).all(days) : db.prepare(sql).all();
  res.json(reminders);
});

// ============ 定时提醒（由 GitHub Actions 定时工作流调用，替代 Vercel Cron）============
// 通过 CRON_SECRET 环境变量鉴权，避免被随意调用。
// 实际发送时间由「提醒设置」页面配置（北京时间 hour），未到时间则跳过。
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // UTC+8
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

app.get('/api/cron/reminders', async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const cfg = getReminderSettings();
  if (!cfg.enabled) {
    return res.json({ skipped: true, reason: '提醒未启用（请在「邮件配置-定时提醒设置」中开启）' });
  }
  const now = beijingNow();
  if (now.h !== cfg.hour) {
    return res.json({ skipped: true, reason: '未到配置的发送时间', now: `${now.h}:${now.m}`, schedule: `${cfg.hour}:${cfg.minute}` });
  }
  try {
    const r = await checkAndSendReminders();
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ 仪表盘 API ============

app.get('/api/dashboard', requireAuth, (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks').all();
  const total = tasks.length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const inProgress = tasks.filter(t => t.status === 'in_progress').length;
  const pending = tasks.filter(t => t.status === 'pending').length;

  const today = new Date().toISOString().split('T')[0];
  const upcoming = tasks
    .filter(t => t.status !== 'completed' && t.end_date && t.end_date >= today)
    .map(t => ({ ...t, days_left: getDaysUntil(t.end_date) }))
    .filter(t => t.days_left !== null && t.days_left >= 0 && t.days_left <= 7)
    .sort((a, b) => a.days_left - b.days_left);

  const overdue = tasks
    .filter(t => t.status !== 'completed' && t.end_date && t.end_date < today)
    .map(t => ({ ...t, days_left: getDaysUntil(t.end_date) }));

  // Category stats
  const catMap = {};
  tasks.forEach(t => {
    if (!catMap[t.category]) catMap[t.category] = { total: 0, completed: 0, in_progress: 0, pending: 0 };
    catMap[t.category].total++;
    if (t.status === 'completed') catMap[t.category].completed++;
    else if (t.status === 'in_progress') catMap[t.category].in_progress++;
    else catMap[t.category].pending++;
  });

  res.json({
    total, completed, inProgress, pending,
    upcoming, overdue,
    categories: catMap,
    completionRate: total > 0 ? Math.round(completed / total * 100) : 0
  });
});

// ============ 报表 API ============

app.get('/api/reports/weekly', requireAuth, (req, res) => {
  const { week } = req.query; // e.g. "2026-W29"
  let startDate, endDate;
  if (week) {
    const [year, w] = week.split('-W');
    const simple = new Date(parseInt(year), 0, 1 + (parseInt(w) - 1) * 7);
    const dow = simple.getDay();
    const weekStart = new Date(simple);
    if (dow <= 4) weekStart.setDate(simple.getDate() - simple.getDay() + 1);
    else weekStart.setDate(simple.getDate() + 8 - simple.getDay());
    startDate = weekStart.toISOString().split('T')[0];
    endDate = new Date(weekStart.getTime() + 6 * 86400000).toISOString().split('T')[0];
  } else {
    const now = new Date();
    const day = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - day + 1);
    startDate = monday.toISOString().split('T')[0];
    endDate = new Date(monday.getTime() + 6 * 86400000).toISOString().split('T')[0];
  }

  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE (start_date <= ? AND end_date >= ?)
       OR (end_date >= ? AND end_date <= ?)
       OR (start_date >= ? AND start_date <= ?)
    ORDER BY end_date ASC
  `).all(endDate, startDate, startDate, endDate, startDate, endDate);

  const logs = db.prepare(`
    SELECT l.*, t.name as task_name FROM task_logs l
    JOIN tasks t ON l.task_id = t.task_id
    WHERE l.created_at >= ? AND l.created_at <= ?
    ORDER BY l.created_at DESC
  `).all(startDate, endDate + ' 23:59:59');

  const completedThisWeek = tasks.filter(t => t.status === 'completed').length;
  const progress = db.prepare(`
    SELECT p.*, t.name as task_name FROM task_progress p
    JOIN tasks t ON p.task_id = t.task_id
    WHERE p.recorded_at >= ? AND p.recorded_at <= ?
    ORDER BY p.recorded_at DESC
  `).all(startDate, endDate + ' 23:59:59');

  res.json({
    period: { start: startDate, end: endDate },
    totalTasks: tasks.length,
    completedTasks: completedThisWeek,
    tasks,
    logs,
    progress
  });
});

app.get('/api/reports/monthly', requireAuth, (req, res) => {
  const { month } = req.query; // e.g. "2026-07"
  let year, mon;
  if (month) {
    [year, mon] = month.split('-').map(Number);
  } else {
    const now = new Date();
    year = now.getFullYear();
    mon = now.getMonth() + 1;
  }

  const startDate = `${year}-${String(mon).padStart(2, '0')}-01`;
  const lastDay = new Date(year, mon, 0).getDate();
  const endDate = `${year}-${String(mon).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE (start_date <= ? AND end_date >= ?)
       OR (end_date >= ? AND end_date <= ?)
       OR (start_date >= ? AND start_date <= ?)
    ORDER BY end_date ASC
  `).all(endDate, startDate, startDate, endDate, startDate, endDate);

  const completed = tasks.filter(t => t.status === 'completed');
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const pending = tasks.filter(t => t.status === 'pending');

  const milestones = db.prepare('SELECT * FROM milestones').all();
  const monthMilestones = milestones.filter(m => {
    const s = m.time_node;
    return s.includes(`${year}年${mon}月`) || s.includes(`${year}-${String(mon).padStart(2,'0')}`);
  });

  // Category breakdown
  const catMap = {};
  tasks.forEach(t => {
    if (!catMap[t.category]) catMap[t.category] = { total: 0, completed: 0, pending: 0 };
    catMap[t.category].total++;
    if (t.status === 'completed') catMap[t.category].completed++;
    else catMap[t.category].pending++;
  });

  res.json({
    period: { start: startDate, end: endDate, month: `${year}-${String(mon).padStart(2,'0')}` },
    totalTasks: tasks.length,
    completedTasks: completed.length,
    inProgressTasks: inProgress.length,
    pendingTasks: pending.length,
    completionRate: tasks.length > 0 ? Math.round(completed.length / tasks.length * 100) : 0,
    tasks,
    milestones: monthMilestones,
    categories: catMap
  });
});

// ============ 里程碑 & 风险 API ============

app.get('/api/milestones', requireAuth, (req, res) => {
  const milestones = db.prepare('SELECT * FROM milestones ORDER BY id ASC').all();
  res.json(milestones);
});

app.get('/api/risks', requireAuth, (req, res) => {
  const risks = db.prepare('SELECT * FROM risks ORDER BY id ASC').all();
  res.json(risks);
});

// ============ 用户管理 API（仅超管） ============

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const users = listUsers();
  res.json(users);
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  const existing = getUserByUsername(username);
  if (existing) return res.status(400).json({ error: '用户名已存在' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = createUser(username, hash, display_name, role || 'user');
    res.json({ success: true, id: result.lastInsertRowid, message: '用户创建成功' });
  } catch (err) {
    res.status(500).json({ error: '创建用户失败: ' + err.message });
  }
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { display_name, role, enabled, password } = req.body;
  const fields = {};
  if (display_name !== undefined) fields.display_name = display_name;
  if (role !== undefined) fields.role = role;
  if (enabled !== undefined) fields.enabled = enabled;

  // 不许禁用自己的账号
  if (enabled === false && parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: '不能禁用自己的账号' });
  }

  if (password) {
    if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });
    fields.password_hash = bcrypt.hashSync(password, 10);
  }

  if (Object.keys(fields).length === 0) return res.status(400).json({ error: '没有要更新的字段' });

  updateUser(req.params.id, fields);
  res.json({ success: true, message: '用户信息已更新' });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: '不能删除自己的账号' });
  }
  const result = deleteUser(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, message: '用户已删除' });
});

// ============ 静态文件服务（生产环境：H5构建产物） ============

const h5DistPath = path.join(__dirname, 'h5-app', 'dist');
if (fs.existsSync(h5DistPath)) {
  app.use(express.static(h5DistPath));
  // SPA fallback
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(h5DistPath, 'index.html'), (err) => {
      if (err) next();
    });
  });
}

// ============ 初始化与启动 ============

// 直接运行时启动（非 Vercel 环境 / 本地开发）
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  ensureReady().then(() => {
    app.listen(PORT, () => {
      console.log(`\n========================================`);
      console.log(`  闻道任务跟踪系统已启动`);
      console.log(`  访问地址: http://localhost:${PORT}`);
      console.log(`========================================\n`);
      // 本地环境：每 12 小时检查一次倒计时提醒
      // Vercel 环境由 GitHub Actions 定时工作流调用 /api/cron/reminders 接管
      setInterval(() => {
        checkAndSendReminders().catch(console.error);
      }, 12 * 60 * 60 * 1000);
      console.log('[调度器] 本地定时提醒已启动（每12小时），Vercel 环境由 GitHub Actions 定时工作流接管');
    });
  }).catch(err => {
    console.error('初始化失败:', err);
    process.exit(1);
  });
}

// 导出给 Vercel Serverless 使用
module.exports = { app, ensureReady };

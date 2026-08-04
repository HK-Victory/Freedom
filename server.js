const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { db, getEmailConfig, upsertEmailConfig, getReminderSettings, setReminderSettings, getStorageStatus, getLastSave, initDefaultAdmin, getUserByUsername, listUsers, createUser, updateUser, deleteUser, ensureReady, storageFailure } = require('./db');
const { syncExcel, resetAndSync } = require('./excel-reader');
const { sendTestEmail, sendTaskReminder } = require('./email');
const { checkAndSendReminders, getDaysUntil } = require('./scheduler');
const { signToken, requireAuth, optionalAuth, requireAdmin } = require('./auth');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

// 异步路由错误兜底：Express 4 不会自动 catch async 抛错，统一转发到错误处理器。
// 注意：错误处理中间件必须注册在「所有路由之后」才会生效（见文件末尾），此处仅定义包装器。
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 存储不可用时的统一拦截：直接给出「为什么连不上数据库」，
// 而不是让业务代码抛出 sql.js 的 wasm ENOENT 这类误导性底层错误。
// /api/health 是诊断入口，必须放行。
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  const reason = storageFailure();
  if (reason) return res.status(503).json({ error: reason });
  next();
});

// 文件上传配置
// 重要：Vercel serverless 的代码目录 (/var/task) 是只读的，不能在代码目录下建 uploads 目录，
// 否则模块加载阶段 multer 就会 mkdir 失败，导致整个服务启动崩溃（所有接口 500）。
// 因此上传目录必须用 serverless 唯一可写的 /tmp（本地开发则仍用 data/uploads）。
const UPLOAD_DIR = process.env.VERCEL
  ? path.join('/tmp', 'task-tracker-uploads')
  : path.join(__dirname, 'data', 'uploads');
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ============ 认证 API ============

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });

  const user = await getUserByUsername(username);
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
}));

// 公开健康检查：只暴露连通性与失败原因，不含任何业务数据（便于部署后一行命令自验）。
// 该接口必须【永不 500】，否则存储挂掉时反而无法定位根因。
// 注意：旧版这里读的是 s.postgres.*，而 getStorageStatus() 早已改为返回 supabase/sqlite，
// 属性不存在会抛错被吞掉，导致永远显示未连接 —— 已修正。
app.get('/api/health', async (req, res) => {
  let storage = null;
  let statusError = null;
  try {
    storage = await getStorageStatus();
  } catch (e) {
    statusError = (e && e.message) || String(e);
  }
  res.json({
    ok: true,
    service: 'freedom',
    driver: storage ? storage.driver : null,
    supabase: storage ? {
      urlConfigured: storage.supabase.urlConfigured,
      keyConfigured: storage.supabase.keyConfigured,
      connected: storage.supabase.connected,
      connectError: storage.supabase.connectError
    } : null,
    sqlite: storage ? {
      active: storage.sqlite.active,
      engine: storage.sqlite.engine,
      initError: storage.sqlite.initError
    } : null,
    storageError: storageFailure(),
    statusError,
    time: new Date().toISOString()
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/change-password', requireAuth, asyncHandler(async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: '旧密码和新密码不能为空' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密码至少6位' });

  const user = await getUserByUsername(req.user.username);
  if (!bcrypt.compareSync(old_password, user.password_hash)) {
    return res.status(400).json({ error: '旧密码错误' });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  await updateUser(req.user.id, { password_hash: hash });
  res.json({ success: true, message: '密码修改成功' });
}));

// ============ 任务 API ============

app.get('/api/tasks', requireAuth, asyncHandler(async (req, res) => {
  const { status, category } = req.query;
  let sql = 'SELECT * FROM tasks';
  const conditions = [];
  const params = {};
  if (status) { conditions.push('status = @status'); params.status = status; }
  if (category) { conditions.push('category = @category'); params.category = category; }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY end_date ASC';
  const tasks = await db.prepare(sql).all(params);
  tasks.forEach(t => {
    t.days_left = getDaysUntil(t.end_date);
  });
  res.json(tasks);
}));

app.get('/api/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const task = await db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  task.days_left = getDaysUntil(task.end_date);

  const doc = await db.prepare('SELECT * FROM documents WHERE task_id = ?').get(req.params.id);
  task.document = doc ? doc.content : '';

  const logs = await db.prepare('SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
  task.logs = logs;

  const progress = await db.prepare('SELECT * FROM task_progress WHERE task_id = ? ORDER BY recorded_at DESC').all(req.params.id);
  task.progress_history = progress;

  res.json(task);
}));

app.put('/api/tasks/:id/status', requireAuth, asyncHandler(async (req, res) => {
  const { status } = req.body;
  const valid = ['pending', 'in_progress', 'completed', 'overdue'];
  if (!valid.includes(status)) return res.status(400).json({ error: '无效状态' });
  await db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now','localtime') WHERE task_id = ?")
    .run(status, req.params.id);
  await db.prepare('INSERT INTO task_logs (task_id, action, content, operator) VALUES (?, ?, ?, ?)')
    .run(req.params.id, 'status_change', `状态变更为: ${status}`, req.body.operator || '用户');
  res.json({ success: true });
}));

app.put('/api/tasks/:id/progress', requireAuth, asyncHandler(async (req, res) => {
  const { progress, note } = req.body;
  await db.prepare('INSERT INTO task_progress (task_id, progress, note) VALUES (?, ?, ?)')
    .run(req.params.id, progress, note || '');
  if (progress >= 100) {
    await db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now','localtime') WHERE task_id = ?")
      .run('completed', req.params.id);
  } else if (progress > 0) {
    await db.prepare("UPDATE tasks SET status = ?, updated_at = datetime('now','localtime') WHERE task_id = ?")
      .run('in_progress', req.params.id);
  }
  res.json({ success: true });
}));

// ---- 创建新任务 ----
app.post('/api/tasks', requireAuth, asyncHandler(async (req, res) => {
  const { task_id, category, name, requirements, priority, start_date, end_date, owner, resources, dependency, status } = req.body;
  if (!task_id || !name) return res.status(400).json({ error: '任务ID和任务名称不能为空' });

  const existing = await db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(task_id);
  if (existing) return res.status(400).json({ error: '任务ID已存在' });

  await db.prepare(`
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
  await db.prepare('INSERT INTO documents (task_id, content) VALUES (?, ?) ON CONFLICT(task_id) DO NOTHING').run(task_id, '');

  await db.prepare('INSERT INTO task_logs (task_id, action, content, operator) VALUES (?, ?, ?, ?)')
    .run(task_id, 'create', '手动创建任务', req.body.operator || '用户');

  res.json({ success: true, task_id });
}));

// ---- 编辑任务（全字段更新）----
app.put('/api/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.id;
  const existing = await db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '任务不存在' });

  const { category, name, requirements, priority, start_date, end_date, owner, resources, dependency, status } = req.body;

  await db.prepare(`
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

  await db.prepare('INSERT INTO task_logs (task_id, action, content, operator) VALUES (?, ?, ?, ?)')
    .run(id, 'edit', '编辑任务信息', req.body.operator || '用户');

  res.json({ success: true });
}));

// ---- 删除任务 ----
app.delete('/api/tasks/:id', requireAuth, asyncHandler(async (req, res) => {
  const id = req.params.id;
  const existing = await db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(id);
  if (!existing) return res.status(404).json({ error: '任务不存在' });

  await db.prepare('DELETE FROM task_progress WHERE task_id = ?').run(id);
  await db.prepare('DELETE FROM task_logs WHERE task_id = ?').run(id);
  await db.prepare('DELETE FROM documents WHERE task_id = ?').run(id);
  await db.prepare('DELETE FROM reminders WHERE task_id = ?').run(id);
  await db.prepare('DELETE FROM tasks WHERE task_id = ?').run(id);

  res.json({ success: true });
}));

// ============ 文档 API ============

app.get('/api/tasks/:id/document', requireAuth, asyncHandler(async (req, res) => {
  const doc = await db.prepare('SELECT * FROM documents WHERE task_id = ?').get(req.params.id);
  if (!doc) return res.json({ content: '', updated_at: '', updated_by: '' });
  res.json(doc);
}));

app.put('/api/tasks/:id/document', requireAuth, asyncHandler(async (req, res) => {
  const { content, updated_by } = req.body;
  await db.prepare(`
    INSERT INTO documents (task_id, content, updated_at, updated_by)
    VALUES (?, ?, datetime('now','localtime'), ?)
    ON CONFLICT(task_id) DO UPDATE SET
      content = ?, updated_at = datetime('now','localtime'), updated_by = ?
  `).run(req.params.id, content, updated_by || '匿名用户', content, updated_by || '匿名用户');

  await db.prepare('INSERT INTO task_logs (task_id, action, content, operator) VALUES (?, ?, ?, ?)')
    .run(req.params.id, 'document_edit', '更新任务文档', updated_by || '匿名用户');

  res.json({ success: true, updated_at: new Date().toLocaleString('zh-CN') });
}));

// ============ 邮件配置 API ============

app.get('/api/email/config', requireAuth, asyncHandler(async (req, res) => {
  const cfg = await getEmailConfig();
  // 不返回密码明文
  res.json({
    ...cfg,
    smtp_pass: cfg.smtp_pass ? '******' : ''
  });
}));

app.post('/api/email/config', requireAuth, asyncHandler(async (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_secure, sender_name, enabled } = req.body;
  const existing = await getEmailConfig();
  const finalPass = (smtp_pass === '******' || !smtp_pass) ? existing.smtp_pass : smtp_pass;
  await upsertEmailConfig({
    smtp_host: smtp_host || '',
    smtp_port: smtp_port || 465,
    smtp_user: smtp_user || '',
    smtp_pass: finalPass,
    smtp_secure: smtp_secure !== undefined ? (smtp_secure ? 1 : 0) : 1,
    sender_name: sender_name || '闻道任务提醒',
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : 0
  });
  res.json({ success: true });
}));

app.post('/api/email/test', requireAuth, asyncHandler(async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: '请提供收件邮箱' });
    const info = await sendTestEmail(to);
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ============ 收件人 API ============

app.get('/api/email/recipients', requireAuth, asyncHandler(async (req, res) => {
  const recipients = await db.prepare('SELECT * FROM email_recipients ORDER BY created_at DESC').all();
  res.json(recipients);
}));

app.post('/api/email/recipients', requireAuth, asyncHandler(async (req, res) => {
  const { email, name, scope, task_ids } = req.body;
  if (!email) return res.status(400).json({ error: '邮箱不能为空' });
  const existing = await db.prepare('SELECT id FROM email_recipients WHERE email = ?').get(email);
  if (existing) return res.status(400).json({ error: '该邮箱已存在' });
  await db.prepare('INSERT INTO email_recipients (email, name, scope, task_ids) VALUES (?, ?, ?, ?)')
    .run(email, name || '', scope || 'all', JSON.stringify(task_ids || []));
  res.json({ success: true });
}));

app.delete('/api/email/recipients/:id', requireAuth, asyncHandler(async (req, res) => {
  await db.prepare('DELETE FROM email_recipients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
}));

app.put('/api/email/recipients/:id', requireAuth, asyncHandler(async (req, res) => {
  const { email, name, scope, task_ids, enabled } = req.body;
  await db.prepare('UPDATE email_recipients SET email=?, name=?, scope=?, task_ids=?, enabled=? WHERE id=?')
    .run(email, name || '', scope || 'all', JSON.stringify(task_ids || []), enabled !== undefined ? (enabled ? 1 : 0) : 1, req.params.id);
  res.json({ success: true });
}));

// ============ 提醒设置 API（页面可配置定时发送时间 / 提前提醒天数）============

app.get('/api/settings/reminder', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  res.json(await getReminderSettings());
}));

app.put('/api/settings/reminder', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  try {
    await setReminderSettings(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ============ 存储状态诊断（仅超管）============
// 用于确认 SUPABASE_DB_URL 是否在运行时真正生效、数据是否成功写入 Supabase。
app.get('/api/storage/status', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  try {
    res.json(await getStorageStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.post('/api/storage/save', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  // Supabase Postgres 为实时持久化，无独立「落盘」动作；此接口用于主动探测连接健康度。
  try {
    res.json({ success: true, ...(await getStorageStatus()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ============ Excel 同步 API ============

app.post('/api/sync', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  try {
    const { filePath, reset } = req.body;
    const targetPath = filePath || path.join(__dirname, 'data', '闻道包装设计工作室计划书.xlsx');
    const result = reset ? await resetAndSync(targetPath) : await syncExcel(targetPath);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ---- 上传Excel文件并重置导入 ----
app.post('/api/import-excel', requireAuth, requireAdmin, upload.single('file'), asyncHandler(async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请上传Excel文件' });
    const uploadedPath = req.file.path;

    // 同时复制一份到 data 目录作为备份
    const backupPath = path.join(__dirname, 'data', '闻道包装设计工作室计划书.xlsx');
    try { fs.copyFileSync(uploadedPath, backupPath); } catch (e) { /* 忽略复制错误 */ }

    const result = await resetAndSync(uploadedPath);

    // 清理临时文件
    try { fs.unlinkSync(uploadedPath); } catch (e) { /* 忽略 */ }

    res.json({ success: true, ...result, message: `导入完成：${result.tasks}项任务, ${result.milestones}个里程碑, ${result.risks}个风险` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ============ 手动触发提醒 API ============

app.post('/api/reminders/trigger', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  try {
    const r = await checkAndSendReminders({ includeOverdue: true, force: true });
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

app.get('/api/reminders', requireAuth, asyncHandler(async (req, res) => {
  const { days } = req.query;
  let sql = `SELECT r.*, t.name as task_name, t.end_date, t.owner
    FROM reminders r JOIN tasks t ON r.task_id = t.task_id`;
  // 用 SQLite 风格 date('now','localtime','-' || ? || ' days')，翻译层会自动转成 Postgres 的
  // to_char(CURRENT_DATE - ($1)::int, ...)；SQLite 模式则原生执行。
  if (days) sql += ` WHERE r.reminder_date >= date('now','localtime','-' || ? || ' days')`;
  sql += ' ORDER BY r.reminder_date DESC';
  const reminders = days ? await db.prepare(sql).all(days) : await db.prepare(sql).all();
  res.json(reminders);
}));

// ============ 定时提醒（由 GitHub Actions 定时工作流调用，替代 Vercel Cron）============
// 通过 CRON_SECRET 环境变量鉴权，避免被随意调用。
// 实际发送时间由「提醒设置」页面配置（北京时间 hour），未到时间则跳过。
function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // UTC+8
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

app.get('/api/cron/reminders', asyncHandler(async (req, res) => {
  const secret = req.query.secret || req.headers['x-cron-secret'];
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const cfg = await getReminderSettings();
  if (!cfg.enabled) {
    return res.json({ skipped: true, reason: '提醒未启用（请在「邮件配置-定时提醒设置」中开启）' });
  }
  const now = beijingNow();
  if (now.h !== cfg.hour) {
    return res.json({ skipped: true, reason: '未到配置的发送时间', now: `${now.h}:${now.m}`, schedule: `${cfg.hour}:${cfg.minute}` });
  }
  try {
    // 定时任务与单次触发共用「临期+逾期」筛选规则；此处尊重当日去重
    const r = await checkAndSendReminders({ includeOverdue: true });
    res.json({ success: true, ...r });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ============ 仪表盘 API ============

app.get('/api/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const tasks = await db.prepare('SELECT * FROM tasks').all();
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
}));

// ============ 报表 API ============

app.get('/api/reports/weekly', requireAuth, asyncHandler(async (req, res) => {
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

  const tasks = await db.prepare(`
    SELECT * FROM tasks
    WHERE (start_date <= ? AND end_date >= ?)
       OR (end_date >= ? AND end_date <= ?)
       OR (start_date >= ? AND start_date <= ?)
    ORDER BY end_date ASC
  `).all(endDate, startDate, startDate, endDate, startDate, endDate);

  const logs = await db.prepare(`
    SELECT l.*, t.name as task_name FROM task_logs l
    JOIN tasks t ON l.task_id = t.task_id
    WHERE l.created_at >= ? AND l.created_at <= ?
    ORDER BY l.created_at DESC
  `).all(startDate, endDate + ' 23:59:59');

  const completedThisWeek = tasks.filter(t => t.status === 'completed').length;
  const progress = await db.prepare(`
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
}));

app.get('/api/reports/monthly', requireAuth, asyncHandler(async (req, res) => {
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

  const tasks = await db.prepare(`
    SELECT * FROM tasks
    WHERE (start_date <= ? AND end_date >= ?)
       OR (end_date >= ? AND end_date <= ?)
       OR (start_date >= ? AND start_date <= ?)
    ORDER BY end_date ASC
  `).all(endDate, startDate, startDate, endDate, startDate, endDate);

  const completed = tasks.filter(t => t.status === 'completed');
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const pending = tasks.filter(t => t.status === 'pending');

  const milestones = await db.prepare('SELECT * FROM milestones').all();
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
    period: { start: startDate, end: endDate, month: `${year}-${String(mon).padStart(2, '0')}` },
    totalTasks: tasks.length,
    completedTasks: completed.length,
    inProgressTasks: inProgress.length,
    pendingTasks: pending.length,
    completionRate: tasks.length > 0 ? Math.round(completed.length / tasks.length * 100) : 0,
    tasks,
    milestones: monthMilestones,
    categories: catMap
  });
}));

// ============ 里程碑 & 风险 API ============

app.get('/api/milestones', requireAuth, asyncHandler(async (req, res) => {
  const milestones = await db.prepare('SELECT * FROM milestones ORDER BY id ASC').all();
  res.json(milestones);
}));

app.get('/api/risks', requireAuth, asyncHandler(async (req, res) => {
  const risks = await db.prepare('SELECT * FROM risks ORDER BY id ASC').all();
  res.json(risks);
}));

// ============ 用户管理 API（仅超管） ============

app.get('/api/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const users = await listUsers();
  res.json(users);
}));

app.post('/api/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  const { username, password, display_name, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  const existing = await getUserByUsername(username);
  if (existing) return res.status(400).json({ error: '用户名已存在' });

  const hash = bcrypt.hashSync(password, 10);
  try {
    const result = await createUser(username, hash, display_name, role || 'user');
    res.json({ success: true, id: result.lastInsertRowid, message: '用户创建成功' });
  } catch (err) {
    res.status(500).json({ error: '创建用户失败: ' + err.message });
  }
}));

app.put('/api/users/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
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

  await updateUser(req.params.id, fields);
  res.json({ success: true, message: '用户信息已更新' });
}));

app.delete('/api/users/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: '不能删除自己的账号' });
  }
  const result = await deleteUser(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, message: '用户已删除' });
}));

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

// ============ 错误处理（必须注册在所有路由之后）============

// Express 的错误处理中间件只会捕获「注册位置之后」抛出的错误，
// 因此必须放在全部路由与静态服务之后，才能兜住 asyncHandler 转发过来的异常。
app.use((err, req, res, next) => {
  console.error('[api] 未处理异常:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  const msg = err && err.message ? err.message : '服务器内部错误';
  res.status(500).json({ error: msg });
});

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

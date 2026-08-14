/**
 * lib/audit.js — 审计日志采集层
 *
 * 覆盖两类日志（对应「审计日志」模块的两个页签）：
 *   1) 系统日志 log_type='system'：定时任务调用（谁在什么时候打了 cron 端点、鉴权是否通过）、
 *      定时任务执行结果（发了几封/跳过几条/失败原因）、邮件发送失败等系统运行事件。
 *   2) 用户操作日志 log_type='user'：用户在界面上的增删改操作（任务/用户/收件人/配置等）。
 *
 * 设计要点：
 *   - 【旁路不阻断】审计写库失败绝不影响业务，全链路 try/catch 兜底（db.writeAuditLog 自身也不抛错）。
 *   - 【自动采集】用户操作日志由 auditMiddleware 统一拦截所有写请求(POST/PUT/PATCH/DELETE)自动落库，
 *     不需要在每个路由里手写埋点，将来新增接口也自动被覆盖（未命中映射表时按通用规则记录）。
 *   - 【serverless 可靠性】Vercel 在响应结束后可能立即冻结实例，因此审计必须「先落库、再发响应」，
 *     否则 fire-and-forget 的写入会随机丢失。为避免拖慢接口，写入设 2s 超时兜底。
 *   - 【脱敏】密码、SMTP 授权码、token、secret 等敏感字段一律不入库。
 */

const SENSITIVE_KEYS = [
  'password', 'password_hash', 'new_password', 'old_password', 'confirm_password',
  'pass', 'smtp_pass', 'smtp_password', 'auth_code', 'token', 'secret', 'cron_secret',
  'authorization', 'apikey', 'api_key',
];

// 审计写库的最长等待时间：超过则先放响应走，避免审计拖垮接口体验
const WRITE_TIMEOUT_MS = 2000;

/** 深度脱敏请求体：命中敏感字段名（不区分大小写）的值替换为 '***' */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '…';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEYS.includes(String(k).toLowerCase()) ? '***' : sanitize(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…';
  return value;
}

/** 取客户端 IP：Vercel 经代理转发，真实 IP 在 x-forwarded-for 首位 */
function clientIp(req) {
  const xff = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}

/**
 * 惰性取 db 模块的写入函数。
 * 用 require 而非顶层解构，是为了兼容测试里通过 require.cache 注入的假 db 模块
 * （假模块可能没有 writeAuditLog，此时静默跳过，不能报错）。
 */
async function persist(entry) {
  try {
    const m = require('../db');
    if (!m || typeof m.writeAuditLog !== 'function') return false;
    return await m.writeAuditLog(entry);
  } catch (e) {
    return false;
  }
}

/** 记录系统日志（定时任务调用/执行、系统运行事件） */
async function logSystem(entry = {}) {
  return persist({
    ...entry,
    log_type: 'system',
    operator: entry.operator || '系统',
    detail: typeof entry.detail === 'string' ? entry.detail : JSON.stringify(sanitize(entry.detail) || null),
  });
}

/** 记录用户操作日志（可在路由内手动补充语义更精确的记录） */
async function logUser(req, entry = {}) {
  const user = (req && req.user) || {};
  return persist({
    ...entry,
    log_type: 'user',
    operator: entry.operator || user.username || '匿名',
    operator_id: entry.operator_id != null ? entry.operator_id : user.id,
    operator_role: entry.operator_role || user.role || null,
    ip: entry.ip || clientIp(req),
    user_agent: entry.user_agent || (req && req.headers && req.headers['user-agent']) || null,
    method: entry.method || (req && req.method) || null,
    path: entry.path || (req && req.originalUrl) || null,
    detail: typeof entry.detail === 'string' ? entry.detail : JSON.stringify(sanitize(entry.detail) || null),
  });
}

/**
 * 写操作路由映射表：把 HTTP 方法 + 路径翻译成可读的业务语义。
 * 顺序敏感——更具体的路径（如 /tasks/:id/status）必须排在通用路径（/tasks/:id）之前。
 */
const ROUTE_MAP = [
  { method: 'POST',   re: /^\/api\/auth\/login$/,                    category: 'auth',     action: 'login',           label: '用户登录' },
  { method: 'POST',   re: /^\/api\/auth\/change-password$/,          category: 'auth',     action: 'change_password', label: '修改密码' },

  { method: 'POST',   re: /^\/api\/tasks$/,                          category: 'task',     action: 'create',          label: '新增任务',     targetType: 'task' },
  { method: 'PUT',    re: /^\/api\/tasks\/([^/]+)\/status$/,         category: 'task',     action: 'update_status',   label: '更新任务状态', targetType: 'task' },
  { method: 'PUT',    re: /^\/api\/tasks\/([^/]+)\/progress$/,       category: 'task',     action: 'update_progress', label: '更新任务进度', targetType: 'task' },
  { method: 'PUT',    re: /^\/api\/tasks\/([^/]+)\/document$/,       category: 'task',     action: 'update_document', label: '编辑任务文档', targetType: 'task' },
  { method: 'PUT',    re: /^\/api\/tasks\/([^/]+)$/,                 category: 'task',     action: 'update',          label: '编辑任务',     targetType: 'task' },
  { method: 'DELETE', re: /^\/api\/tasks\/([^/]+)$/,                 category: 'task',     action: 'delete',          label: '删除任务',     targetType: 'task' },

  { method: 'POST',   re: /^\/api\/email\/config$/,                  category: 'email',    action: 'update_config',   label: '保存邮件配置' },
  { method: 'POST',   re: /^\/api\/email\/test$/,                    category: 'email',    action: 'test_send',       label: '发送测试邮件' },
  { method: 'POST',   re: /^\/api\/email\/recipients$/,              category: 'email',    action: 'create',          label: '新增收件人',   targetType: 'recipient' },
  { method: 'PUT',    re: /^\/api\/email\/recipients\/([^/]+)$/,     category: 'email',    action: 'update',          label: '编辑收件人',   targetType: 'recipient' },
  { method: 'DELETE', re: /^\/api\/email\/recipients\/([^/]+)$/,     category: 'email',    action: 'delete',          label: '删除收件人',   targetType: 'recipient' },

  { method: 'PUT',    re: /^\/api\/settings\/reminder$/,             category: 'settings', action: 'update_reminder', label: '保存定时提醒设置' },
  { method: 'POST',   re: /^\/api\/reminders\/trigger$/,             category: 'reminder', action: 'manual_trigger',  label: '手动触发提醒发送' },

  { method: 'POST',   re: /^\/api\/storage\/save$/,                  category: 'storage',  action: 'save',            label: '手动保存数据' },
  { method: 'POST',   re: /^\/api\/sync$/,                           category: 'data',     action: 'sync',            label: '同步 Excel 数据' },
  { method: 'POST',   re: /^\/api\/import-excel$/,                   category: 'data',     action: 'import_excel',    label: '导入 Excel' },

  { method: 'POST',   re: /^\/api\/users$/,                          category: 'user',     action: 'create',          label: '新增用户',     targetType: 'user' },
  { method: 'PUT',    re: /^\/api\/users\/([^/]+)$/,                 category: 'user',     action: 'update',          label: '编辑用户',     targetType: 'user' },
  { method: 'DELETE', re: /^\/api\/users\/([^/]+)$/,                 category: 'user',     action: 'delete',          label: '删除用户',     targetType: 'user' },

  { method: 'DELETE', re: /^\/api\/audit-logs$/,                     category: 'audit',    action: 'cleanup',         label: '清理审计日志' },
];

function matchRoute(method, pathname) {
  for (const r of ROUTE_MAP) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) return { rule: r, targetId: m[1] || null };
  }
  return null;
}

/** 从响应体里尽力提取新建资源的 id（POST 创建类接口用） */
function pickTargetId(body, req) {
  if (body && typeof body === 'object') {
    if (body.task_id != null) return String(body.task_id);
    if (body.id != null) return String(body.id);
    if (body.user && body.user.id != null) return String(body.user.id);
  }
  if (req.body && typeof req.body === 'object') {
    if (req.body.task_id != null) return String(req.body.task_id);
    if (req.body.username != null) return String(req.body.username);
    if (req.body.email != null) return String(req.body.email);
  }
  return null;
}

/**
 * 用户操作日志自动采集中间件。
 *
 * 只拦截 /api 下的写方法（POST/PUT/PATCH/DELETE）；GET 读操作不记录（否则日志会被浏览刷爆，
 * 且读操作无审计价值）。定时任务这类系统事件由 logSystem 在业务代码内显式记录。
 */
function auditMiddleware(req, res, next) {
  const method = (req.method || '').toUpperCase();
  const pathname = (req.path || '').replace(/\/+$/, '') || req.path;

  const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (!isMutating || !pathname.startsWith('/api')) return next();

  const started = Date.now();
  const matched = matchRoute(method, pathname);
  const origJson = res.json.bind(res);
  let done = false;

  res.json = (body) => {
    if (done) return origJson(body);
    done = true;

    const code = res.statusCode || 200;
    const ok = code < 400;
    const rule = matched ? matched.rule : null;
    const user = req.user || {};

    // 登录接口在鉴权前执行，req.user 不存在，操作者只能取请求体里的用户名
    const operator = user.username
      || (rule && rule.action === 'login' && req.body && req.body.username)
      || '匿名';

    const targetId = (matched && matched.targetId) || pickTargetId(body, req);
    const label = rule ? rule.label : `${method} ${pathname}`;
    const failReason = !ok && body && typeof body === 'object' ? (body.error || body.message) : null;

    const entry = {
      log_type: 'user',
      category: rule ? rule.category : 'other',
      action: rule ? rule.action : method.toLowerCase(),
      target_type: rule ? (rule.targetType || null) : null,
      target_id: targetId,
      summary: ok ? label : `${label}失败：${failReason || '未知原因'}`,
      detail: JSON.stringify({
        body: sanitize(req.body),
        query: sanitize(req.query),
        error: failReason || undefined,
      }),
      status: ok ? 'success' : 'failure',
      operator,
      operator_id: user.id != null ? user.id : null,
      operator_role: user.role || null,
      ip: clientIp(req),
      user_agent: (req.headers && req.headers['user-agent']) || null,
      method,
      path: req.originalUrl || pathname,
      status_code: code,
      duration_ms: Date.now() - started,
    };

    // 关键：先落审计日志再发响应。Vercel serverless 在响应结束后可能立即冻结实例，
    // 若改成 res.on('finish') 里 fire-and-forget，日志会随机丢失。
    // 同时用超时兜底，避免审计慢导致接口卡住。
    const write = persist(entry).catch(() => false);
    const timer = new Promise((resolve) => setTimeout(resolve, WRITE_TIMEOUT_MS));
    Promise.race([write, timer]).then(() => origJson(body), () => origJson(body));
    return res;
  };

  next();
}

module.exports = { auditMiddleware, logSystem, logUser, sanitize, clientIp, matchRoute, ROUTE_MAP };

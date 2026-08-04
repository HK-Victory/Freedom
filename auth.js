const jwt = require('jsonwebtoken');
const { getUserById } = require('./db');

const JWT_SECRET = 'wendao-task-tracker-secret-2026';
const JWT_EXPIRES = '7d';

// 签发 JWT token
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, display_name: user.display_name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

// 验证 JWT token
function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// 认证中间件 - 需要登录
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录', code: 'UNAUTHORIZED' });
  }

  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: '登录已过期，请重新登录', code: 'TOKEN_EXPIRED' });
  }

  try {
    // 验证用户是否仍存在且启用
    const user = await getUserById(payload.id);
    if (!user || !user.enabled) {
      return res.status(401).json({ error: '账号已被禁用或不存在', code: 'USER_DISABLED' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// 可选认证中间件 - 如果有token就解析，没有也放行
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);
    if (payload) {
      try {
        const user = await getUserById(payload.id);
        if (user && user.enabled) {
          req.user = user;
        }
      } catch (err) { /* 忽略鉴权异常，按未登录处理 */ }
    }
  }
  next();
}

// 超管中间件
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '权限不足，仅超管可操作', code: 'FORBIDDEN' });
  }
  next();
}

module.exports = { signToken, verifyToken, requireAuth, optionalAuth, requireAdmin, JWT_SECRET };

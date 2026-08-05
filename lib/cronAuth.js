/**
 * lib/cronAuth.js — 定时提醒端点鉴权（与 @vercel/cron 解耦，纯 Node 实现、可单元测试）
 *
 * Vercel Cron 官方机制（vercel.com/docs/cron-jobs/manage-cron-jobs）：
 *   项目配置了环境变量 CRON_SECRET 后，Vercel 在发起定时请求时，会自动在
 *   `Authorization` 头带上【明文】`Bearer <CRON_SECRET>`。端点只需直接比对即可，
 *   无需任何 HMAC 计算。这是 Vercel 当前稳定行为，多个官方/社区示例均如此。
 *
 * 两条触发链共用同一个 CRON_SECRET：
 *   ① Vercel Cron：请求头 `authorization: Bearer <CRON_SECRET>`（明文）
 *   ② GitHub Actions 工作流：URL 带 `?secret=<CRON_SECRET>`，或自定义 `x-cron-secret` 头
 *
 * CRON_SECRET 未配置时退回「不校验」（保留旧行为，任何人可调用，风险自负）。
 *
 * 注意：Vercel Cron 与 GitHub Actions 必须【同时】配置同一取值的 CRON_SECRET，
 * 否则一端能比对通过、另一端 401，只剩一条链兜底。
 */

function isCronAuthorized(req, cronSecret) {
  if (!cronSecret) return true; // 未配置 → 开放（旧行为）

  const headers = (req && (req.headers || {})) || {};
  const auth = headers['authorization'] || headers.authorization;

  // ① Vercel Cron：明文 Bearer 比对（官方机制）
  if (auth && auth === 'Bearer ' + cronSecret) return true;

  // ② GitHub Actions：?secret= 或 x-cron-secret 头
  const query = (req && (req.query || {})) || {};
  const secret = query.secret || headers['x-cron-secret'];
  if (secret && secret === cronSecret) return true;

  return false;
}

module.exports = { isCronAuthorized };

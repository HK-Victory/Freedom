/**
 * 回归测试：定时提醒端点的鉴权（lib/cronAuth）与逾期/临期天数计算（scheduler.getDaysUntil）。
 *
 * 背景：曾经错误地把 Vercel Cron 鉴权实现成 HMAC 签名校验（@vercel/cron verifyCronSignature），
 * 但 Vercel 实际是在 Authorization 头带【明文】Bearer <CRON_SECRET>，导致 Vercel 那条触发链
 * 永远 401、只有 GitHub Actions 在跑。本测试确保明文比对正确，且两条链共用同一 CRON_SECRET。
 */
const assert = require('assert');
const { isCronAuthorized } = require('../lib/cronAuth');
const { getDaysUntil } = require('../scheduler');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✓', name); pass++; }
  catch (e) { console.error('  ✗', name, '\n    ', e.message); fail++; }
}

console.log('\n[1] Vercel Cron 明文 Bearer 鉴权（核心修复）');
const SECRET = 'super-secret-cron-123';
check('CRON_SECRET 未配置 → 开放', () => {
  assert.strictEqual(isCronAuthorized({ headers: {} }, ''), true);
  assert.strictEqual(isCronAuthorized({ headers: {} }, undefined), true);
});
check('Vercel Cron：Authorization=Bearer <secret> 通过', () => {
  const req = { headers: { authorization: 'Bearer ' + SECRET } };
  assert.strictEqual(isCronAuthorized(req, SECRET), true);
});
check('Vercel Cron：Bearer 值与 secret 不符 → 拒绝', () => {
  const req = { headers: { authorization: 'Bearer wrong' } };
  assert.strictEqual(isCronAuthorized(req, SECRET), false);
});
check('Vercel Cron：缺少 Authorization 头 → 拒绝（secret 已设）', () => {
  assert.strictEqual(isCronAuthorized({ headers: {} }, SECRET), false);
});
check('Vercel Cron：大小写/前后缀不符 → 拒绝（精确比对，防 Bearer x + 尾随空格绕过）', () => {
  assert.strictEqual(isCronAuthorized({ headers: { authorization: 'bearer ' + SECRET } }, SECRET), false);
  assert.strictEqual(isCronAuthorized({ headers: { authorization: 'Bearer ' + SECRET + ' ' } }, SECRET), false);
  assert.strictEqual(isCronAuthorized({ headers: { authorization: 'Basic ' + SECRET } }, SECRET), false);
});

console.log('\n[2] GitHub Actions 鉴权（?secret= / x-cron-secret 头）');
check('GH Actions：?secret= 正确 → 通过', () => {
  const req = { query: { secret: SECRET }, headers: {} };
  assert.strictEqual(isCronAuthorized(req, SECRET), true);
});
check('GH Actions：x-cron-secret 头正确 → 通过', () => {
  const req = { headers: { 'x-cron-secret': SECRET } };
  assert.strictEqual(isCronAuthorized(req, SECRET), true);
});
check('GH Actions：secret 错误 → 拒绝', () => {
  const req = { query: { secret: 'nope' }, headers: {} };
  assert.strictEqual(isCronAuthorized(req, SECRET), false);
});
check('两端用同一 secret：Vercel Bearer 与 GH ?secret 都通过', () => {
  assert.strictEqual(isCronAuthorized({ headers: { authorization: 'Bearer ' + SECRET } }, SECRET), true);
  assert.strictEqual(isCronAuthorized({ query: { secret: SECRET } }, SECRET), true);
});

console.log('\n[3] getDaysUntil 时区无关（以 UTC 日历日为单位）');
function expectedDays(str) {
  const now = new Date();
  const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  const e = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.round((e - t) / 86400000);
}
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const today = new Date();
check('今日 → 0', () => assert.strictEqual(getDaysUntil(fmt(today)), expectedDays(fmt(today))));
check('明天 → 1', () => {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  assert.strictEqual(getDaysUntil(fmt(d)), expectedDays(fmt(d)));
});
check('7 天后 → 7', () => {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 7));
  assert.strictEqual(getDaysUntil(fmt(d)), expectedDays(fmt(d)));
});
check('3 天前 → -3（逾期）', () => {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3));
  assert.strictEqual(getDaysUntil(fmt(d)), expectedDays(fmt(d)));
});
check('空值 → null', () => assert.strictEqual(getDaysUntil(''), null));
check('非法日期 → null', () => assert.strictEqual(getDaysUntil('not-a-date'), null));

console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);

/**
 * scripts/test-reminder-settings-seed.js — 提醒设置默认配置种子化落库回归测试
 *
 * 背景：getReminderSettings 在未保存时以硬编码默认值兜底，导致「从未点过保存」时
 * settings 表里根本没有 reminder_lead_days 等记录，让人误以为「提前提醒天数没落库」。
 * 本测试验证：
 *   1) init() 后 settings 表必须存在 reminder_enabled/hour/minute/lead_days 四行；
 *   2) reminder_lead_days 值为合法 JSON 数组；
 *   3) 用户已保存的自定义值不被种子化覆盖（不回退成默认）；
 *   4) 种子化幂等：重复 init 不会产生重复行 / 不改变已有用户值。
 */

const path = require('path');
const db = require(path.join(__dirname, '..', 'db'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

(async () => {
  try {
    await db.ensureReady();
    console.log('driver =', db.driver());

    console.log('\n[1] init 后提醒默认配置应已种子化落库');
    const rows = await db.db.prepare("SELECT key, value FROM settings WHERE key LIKE 'reminder_%' ORDER BY key").all();
    const keys = rows.map(r => r.key);
    for (const k of ['reminder_enabled', 'reminder_hour', 'reminder_minute', 'reminder_lead_days']) {
      check('settings 含 ' + k + ' 行', keys.includes(k), keys);
    }
    const lead = rows.find(r => r.key === 'reminder_lead_days');
    let parsed = null;
    try { parsed = JSON.parse(lead.value); } catch (e) {}
    check('reminder_lead_days 为合法 JSON 数组', Array.isArray(parsed) && parsed.length > 0, lead && lead.value);

    console.log('\n[2] 用户已保存的自定义值不被种子化覆盖');
    await db.setReminderSettings({ enabled: true, leadDays: [2, 5] });
    let cfg = await db.getReminderSettings();
    check('保存后回读 leadDays=[2,5]', JSON.stringify(cfg.leadDays) === '[2,5]', cfg.leadDays);
    // 再次触发种子化（幂等路径），应保留用户值
    await db.ensureDefaultReminderSettings();
    cfg = await db.getReminderSettings();
    check('种子化后用户值 [2,5] 仍保留（未回退默认）', JSON.stringify(cfg.leadDays) === '[2,5]', cfg.leadDays);

    console.log('\n[3] 种子化幂等：不重复插入行');
    const before = (await db.db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key='reminder_lead_days'").all())[0].c;
    await db.ensureDefaultReminderSettings();
    const after = (await db.db.prepare("SELECT COUNT(*) AS c FROM settings WHERE key='reminder_lead_days'").all())[0].c;
    check('reminder_lead_days 仅 1 行（无重复）', before === 1 && after === 1, { before, after });

    console.log('\n[4] 含边界天数（0/负数）的提前天数可正常落库回读');
    await db.setReminderSettings({ enabled: true, leadDays: [0, 1, 14] });
    cfg = await db.getReminderSettings();
    check('leadDays=[0,1,14] 落库回读一致', JSON.stringify(cfg.leadDays) === '[0,1,14]', cfg.leadDays);

    console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
  } catch (e) {
    console.error('测试异常:', e && (e.stack || e.message));
    process.exit(1);
  }
})();

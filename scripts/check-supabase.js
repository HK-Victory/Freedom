/**
 * 直接验证「真实 Supabase Postgres」连接与表结构是否可用。
 *
 * 与 scripts/functional-test-supabase.js（用 PGlite 离线 mock）不同，本脚本
 * 直连你配置的 Supabase 实例，走与线上完全一致的 db.js 路径：
 *   ensureReady()  → 建 11 张表 + 默认超管
 *   getStorageStatus() → 探测连通性 + 各表行数
 *   一条真实 SELECT  → 验证 SQL 方言翻译层对真实 Postgres 工作正常
 *
 * 运行（任选其一）：
 *   SUPABASE_DB_URL="postgresql://..." node scripts/check-supabase.js
 *   DATABASE_URL="postgresql://..." node scripts/check-supabase.js
 */
const url = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 SUPABASE_DB_URL / DATABASE_URL。请先设置连接串，例如：');
  console.error('  SUPABASE_DB_URL="postgresql://postgres:<pwd>@db.<ref>.supabase.co:5432/postgres" \\');
  console.error('    node scripts/check-supabase.js');
  process.exit(1);
}
// db.js 在加载时读取 process.env.SUPABASE_DB_URL，必须在 require 之前set
process.env.SUPABASE_DB_URL = url;

(async () => {
  let db;
  try {
    db = require('../db');
  } catch (e) {
    console.error('加载 db.js 失败：', e && (e.stack || e.message));
    process.exit(1);
  }

  try {
    console.log('→ 执行 ensureReady（建 11 张表 + 默认超管）...');
    await db.ensureReady();
    console.log('✓ ensureReady 成功');

    const status = await db.getStorageStatus();
    console.log('\n存储状态：');
    console.log(JSON.stringify(status, null, 2));

    const row = await db.prepare('SELECT count(*) AS n FROM tasks').get();
    console.log('\ntasks 表当前行数：', row && row.n);

    if (status && status.postgres && status.postgres.connected) {
      console.log('\n✅ Supabase 数据库连接可用，SQL 方言翻译层对真实 Postgres 工作正常。');
      process.exit(0);
    } else {
      console.error('\n❌ 连接串已配置但连接失败：', status && status.postgres && status.postgres.connectError);
      process.exit(1);
    }
  } catch (e) {
    console.error('\n❌ 连接/初始化失败：', e && (e.stack || e.message));
    process.exit(1);
  }
})();

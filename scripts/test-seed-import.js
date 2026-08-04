/**
 * 回归测试：内置种子数据（api/embedded-seed.js）必须在两种驱动下都能正确导入。
 *
 * 背景（真实线上事故）：
 *   旧版实现是「把 base64 快照直接当 SQLite 数据库文件打开」，
 *   迁移到 Supabase 原生表后这段加载逻辑被整体删掉，代码里再没有任何地方
 *   引用 api/embedded-seed.js —— 线上表现为「能正常登录，但任务数据全没了」。
 *
 * 本测试用 PGlite（WASM 版真 Postgres）+ scripts/exec_sql.sql 的【真函数】跑 Supabase 路径，
 * 因为种子导入用的是多行 INSERT OR IGNORE，会经翻译层转成
 * `INSERT ... VALUES (...),(...) ON CONFLICT DO NOTHING`，
 * 这条路径必须用真 Postgres 校验，JS 复刻版 mock 证明不了。
 *
 * 必须在独立进程中运行（模块劫持要早于 db.js 加载）。
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');

process.env.SUPABASE_URL = 'https://mock-project.supabase.co';
process.env.SUPABASE_ANON_KEY = 'mock-anon-key';
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_KEY;
delete process.env.SUPABASE_DB_URL;

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  \u2713 ' + name); }
  else { failed++; console.log('  \u2717 ' + name + (extra ? ' \u2014 ' + extra : '')); }
}

let pg = null;

// 用 PGlite 上的【真 exec_sql 函数】支撑假的 supabase 客户端
const origLoad = Module._load;
Module._load = function (request) {
  if (request === '@supabase/supabase-js') {
    return {
      createClient: () => ({
        async rpc(fn, args) {
          if (fn !== 'exec_sql') return { data: null, error: { message: 'unknown fn ' + fn } };
          try {
            const r = await pg.query('SELECT exec_sql($1,$2) AS d', [
              String(args.sql), JSON.stringify(args.params || [])
            ]);
            return { data: r.rows[0].d, error: null };
          } catch (e) {
            return { data: null, error: { message: e.message } };
          }
        }
      })
    };
  }
  return origLoad.apply(this, arguments);
};

// 种子快照里的真实行数（变更种子文件时同步更新，可防止种子被意外清空而无人察觉）
const EXPECT = { tasks: 21, documents: 21, milestones: 12, risks: 10, users: 2, email_config: 1 };

(async () => {
  console.log('\n\u2500\u2500\u2500 内置种子数据导入 回归测试 \u2500\u2500\u2500');

  pg = new PGlite();
  await pg.waitReady;
  const full = fs.readFileSync(path.join(__dirname, 'exec_sql.sql'), 'utf8');
  await pg.query(full.split('REVOKE EXECUTE')[0]);   // PGlite 无角色系统，跳过 GRANT

  const db = require('../db.js');
  await db.init();

  console.log('\n[1] Supabase(真 Postgres) 路径');
  check('驱动选中 supabase', db.driver() === 'supabase', '实际=' + db.driver());

  for (const [t, n] of Object.entries(EXPECT)) {
    const r = await db.db.prepare('SELECT COUNT(*) AS c FROM ' + t).get();
    check(t + ' 导入 ' + n + ' 行', Number(r.c) === n, '实际=' + (r && r.c));
  }

  // 任务内容与外键关联必须完好
  const t1 = await db.db.prepare('SELECT name FROM tasks WHERE task_id = ?').get('T001');
  check('T001 任务内容正确', !!t1 && t1.name === '晶鸿账目核对与清收', JSON.stringify(t1));
  const doc = await db.db.prepare('SELECT content FROM documents WHERE task_id = ?').get('T001');
  check('T001 关联文档存在（外键 task_id 未断）', !!doc);

  // 种子里的 admin 密码就是 admin123，导入后不应改变登录方式
  const admin = await db.getUserByUsername('admin');
  check('admin 存在且启用', !!admin && Number(admin.enabled) === 1, JSON.stringify(admin && admin.enabled));
  check('admin 角色为 admin', !!admin && admin.role === 'admin');
  const bcrypt = require('bcryptjs');
  check('admin 密码仍为 admin123', !!admin && bcrypt.compareSync('admin123', admin.password_hash));

  // 未带 id 插入 → Postgres 的 BIGSERIAL 序列必须仍然可用（这是丢弃 id 的主要目的）
  await db.db.prepare('INSERT INTO tasks (task_id, name) VALUES (?, ?)').run('T999', '序列自增校验');
  const t999 = await db.db.prepare('SELECT id FROM tasks WHERE task_id = ?').get('T999');
  check('导入后仍可正常自增插入（BIGSERIAL 序列未错乱）', !!t999 && Number(t999.id) > 0, JSON.stringify(t999));
  await db.db.prepare('DELETE FROM tasks WHERE task_id = ?').run('T999');

  console.log('\n[2] 幂等性');
  const mark = await db.db.prepare('SELECT value FROM settings WHERE key = ?').get('seed_imported');
  check('已写入 seed_imported 标记', !!mark && mark.value === '1');

  // 重复导入不得产生重复行
  const before = await db.db.prepare('SELECT COUNT(*) AS c FROM tasks').get();
  await db.importEmbeddedSeed();
  const after = await db.db.prepare('SELECT COUNT(*) AS c FROM tasks').get();
  check('重复调用不产生重复数据', Number(before.c) === Number(after.c),
    before && before.c + ' -> ' + (after && after.c));

  // 用户主动清空数据后，绝不能被「好心」还原（否则是数据事故）
  await db.db.prepare('DELETE FROM tasks').run();
  await db.importEmbeddedSeed();
  const cleared = await db.db.prepare('SELECT COUNT(*) AS c FROM tasks').get();
  check('用户清空数据后不会被自动还原', Number(cleared.c) === 0, '实际=' + (cleared && cleared.c));

  console.log('\n' + '\u2500'.repeat(52));
  console.log(failed === 0 ? `\u2705 全部通过（${passed} 项）` : `\u274c ${failed} 项失败 / 共 ${passed + failed} 项`);
  Module._load = origLoad;
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('\u274c 测试异常:', e); process.exit(1); });

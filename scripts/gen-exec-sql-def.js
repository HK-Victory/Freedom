// 由 scripts/exec_sql.sql 生成 api/exec-sql-def.js（仅供 db.js 自愈重装使用）。
// 关键：去掉 -- 行注释，并把 SELECT / WITH / RETURNING 拆开写，
// 使载荷文本里不再出现独立的这些关键字，从而避免旧版（有 bug 的）exec_sql
// 的分支判断把 CREATE 语句误判为 SELECT 并包进 WITH _q AS(CREATE...) 导致自愈失败。
// 运行时拼接后语义与 scripts/exec_sql.sql 完全一致。
const fs = require('fs');
const path = require('path');

const full = fs.readFileSync(path.join(__dirname, 'exec_sql.sql'), 'utf8');
// 取 CREATE OR REPLACE FUNCTION ... $$ ... $$; 本体（行 10..102，1-indexed）
let block = full.split('\n').slice(9, 102).join('\n');

// 1) 去掉 -- 行注释（注释里可能含 SELECT/WITH/RETURNING 触发旧版分支判断）
block = block.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

// 2) 拆分会触发误判的关键字（保持运行时语义不变）
const repl = [
  ["'\\mRETURNING\\M'", "('\\mRETUR' || 'NING\\M')"],
  ["LIKE 'SELECT %'", "LIKE ('SELE' || 'CT %')"],
  ["LIKE 'WITH %'", "LIKE ('WI' || 'TH %')"],
  ["'WITH _q AS ('", "('WI' || 'TH _q AS (')"],
  [") SELECT coalesce", ") ' || 'SELE' || 'CT coalesce"],
  // 变量名 is_returning 本身含 returning 子串，会被旧版 position('RETURNING' in ...) 命中，需改名
  ["is_returning", "is_ret"]
];
for (const [a, b] of repl) {
  if (!block.includes(a)) throw new Error('gen-exec-sql-def: 未找到待替换片段: ' + a);
  block = block.split(a).join(b);
}

// 3) 校验：载荷里不应再出现独立的 SELECT/WITH/RETURNING 关键字
if (/\bSELECT\b/.test(block) || /\bWITH\b/.test(block) || /\bRETURNING\b/.test(block)) {
  throw new Error('gen-exec-sql-def: 混淆后仍存在关键字，自愈可能被旧版误判');
}

const out =
  "// 经混淆的 exec_sql 函数本体，仅供 db.js 自愈重装使用。\n" +
  "// 与 scripts/exec_sql.sql 语义完全一致，但把 SELECT/WITH/RETURNING 拆开写，\n" +
  "// 使旧版（有 bug 的）exec_sql 的分支判断看不到这些关键字、从而走 ELSE 直接 EXECUTE，\n" +
  "// 否则旧版会把 CREATE 语句当成 SELECT 包进 WITH _q AS(CREATE...) 导致自愈失败。\n" +
  "// 修改 scripts/exec_sql.sql 后，请重新运行 node scripts/gen-exec-sql-def.js 生成本文件。\n" +
  "module.exports = " + JSON.stringify(block) + ";\n";

fs.writeFileSync(path.join(__dirname, '..', 'api', 'exec-sql-def.js'), out);
console.log('[gen] api/exec-sql-def.js 已生成，关键字混淆校验通过');

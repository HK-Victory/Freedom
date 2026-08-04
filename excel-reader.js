const XLSX = require('xlsx');
const { db } = require('./db');

function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return val.toISOString().split('T')[0];
  }
  const s = String(val).trim();
  // "2026年7月1日" format
  const cnMatch = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (cnMatch) {
    return `${cnMatch[1]}-${String(cnMatch[2]).padStart(2, '0')}-${String(cnMatch[3]).padStart(2, '0')}`;
  }
  // "2026-07-01" format
  const isoMatch = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, '0')}-${String(isoMatch[3]).padStart(2, '0')}`;
  }
  // "2026年7月" format (no day)
  const cnMonthMatch = s.match(/(\d{4})年(\d{1,2})月/);
  if (cnMonthMatch) {
    return `${cnMonthMatch[1]}-${String(cnMonthMatch[2]).padStart(2, '0')}-01`;
  }
  return s;
}

async function syncExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const results = { sheets: [], tasks: 0, milestones: 0, risks: 0 };

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
    results.sheets.push(sheetName);

    if (sheetName === '任务拆解与执行计划') {
      await syncTasks(rows);
      results.tasks = rows.length - 2;
    }
    if (sheetName === '里程碑与检查机制') {
      await syncMilestones(rows);
      results.milestones = rows.length - 2;
    }
    if (sheetName === '风险管控矩阵') {
      await syncRisks(rows);
      results.risks = rows.length - 2;
    }
  }
  return results;
}

async function syncTasks(rows) {
  const upsert = db.prepare(`
    INSERT INTO tasks (task_id, category, name, requirements, priority, start_date, end_date, owner, resources, dependency, sheet_name, status)
    VALUES (@task_id, @category, @name, @requirements, @priority, @start_date, @end_date, @owner, @resources, @dependency, @sheet_name, @status)
    ON CONFLICT(task_id) DO UPDATE SET
      category=@category, name=@name, requirements=@requirements, priority=@priority,
      start_date=@start_date, end_date=@end_date, owner=@owner, resources=@resources,
      dependency=@dependency, updated_at=datetime('now','localtime')
  `);

  const ensureDoc = db.prepare(`INSERT INTO documents (task_id, content) VALUES (?, ?) ON CONFLICT(task_id) DO NOTHING`);

  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0]) continue;
    const taskId = String(row[0]).trim();
    const existing = await db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId);
    const status = existing ? existing.status : 'pending';

    await upsert.run({
      task_id: taskId,
      category: row[1] ? String(row[1]).trim() : '',
      name: row[2] ? String(row[2]).trim() : '',
      requirements: row[3] ? String(row[3]).trim() : '',
      priority: row[4] ? String(row[4]).trim() : '',
      start_date: parseDate(row[5]),
      end_date: parseDate(row[6]),
      owner: row[7] ? String(row[7]).trim() : '',
      resources: row[8] ? String(row[8]).trim() : '',
      dependency: row[9] ? String(row[9]).trim() : '',
      sheet_name: '任务拆解与执行计划',
      status
    });
    await ensureDoc.run(taskId, '');
  }
}

async function syncMilestones(rows) {
  // 表结构由 db.js ensureSchema 统一创建（含 milestones / risks），此处不再动态建表
  const insert = db.prepare(`INSERT INTO milestones (node_type, time_node, check_content, deliverable, penalty)
    VALUES (@node_type, @time_node, @check_content, @deliverable, @penalty)`);
  await db.prepare('DELETE FROM milestones').run();
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0]) continue;
    await insert.run({
      node_type: row[0] ? String(row[0]).trim() : '',
      time_node: row[1] ? String(row[1]).trim() : '',
      check_content: row[2] ? String(row[2]).trim() : '',
      deliverable: row[3] ? String(row[3]).trim() : '',
      penalty: row[4] ? String(row[4]).trim() : ''
    });
  }
}

async function syncRisks(rows) {
  const insert = db.prepare(`INSERT INTO risks (description, probability, impact, level, measure, owner, trigger)
    VALUES (@description, @probability, @impact, @level, @measure, @owner, @trigger)`);
  await db.prepare('DELETE FROM risks').run();
  for (let i = 2; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0]) continue;
    await insert.run({
      description: row[0] ? String(row[0]).trim() : '',
      probability: row[1] ? String(row[1]).trim() : '',
      impact: row[2] ? String(row[2]).trim() : '',
      level: row[3] ? String(row[3]).trim() : '',
      measure: row[4] ? String(row[4]).trim() : '',
      owner: row[5] ? String(row[5]).trim() : '',
      trigger: row[6] ? String(row[6]).trim() : ''
    });
  }
}

async function resetAndSync(filePath) {
  // 清空所有任务相关数据（保留邮件配置和收件人）
  await db.prepare('DELETE FROM task_progress').run();
  await db.prepare('DELETE FROM task_logs').run();
  await db.prepare('DELETE FROM documents').run();
  await db.prepare('DELETE FROM tasks').run();
  await db.prepare('DELETE FROM milestones').run();
  await db.prepare('DELETE FROM risks').run();
  await db.prepare('DELETE FROM reminders').run();

  // 重新同步
  const result = await syncExcel(filePath);
  result.reset = true;
  return result;
}

module.exports = { syncExcel, resetAndSync, parseDate };

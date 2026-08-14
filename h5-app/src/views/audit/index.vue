<template>
  <div class="audit-page">
    <Navbar active="audit" />

    <div class="container">
      <div class="flex-between mb-12">
        <div>
          <h1 class="page-title">审计日志</h1>
          <p class="page-subtitle">系统运行日志与用户操作留痕（仅管理员可见）</p>
        </div>
        <div class="flex gap-8">
          <button class="btn btn-secondary btn-sm" @click="loadAll" :disabled="loading">
            {{ loading ? '加载中…' : '🔄 刷新' }}
          </button>
          <button class="btn btn-danger btn-sm" @click="showCleanup = true">🧹 清理历史</button>
        </div>
      </div>

      <!-- 概览统计 -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">📚</div>
          <div class="stat-label">总日志</div>
          <div class="stat-value">{{ stats.total }}</div>
        </div>
        <div class="stat-card purple">
          <div class="stat-icon">⚙️</div>
          <div class="stat-label">系统日志</div>
          <div class="stat-value">{{ stats.system }}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-icon">👤</div>
          <div class="stat-label">用户操作</div>
          <div class="stat-value">{{ stats.user }}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-icon">⚠️</div>
          <div class="stat-label">失败记录</div>
          <div class="stat-value">{{ stats.failure }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📅</div>
          <div class="stat-label">今日新增</div>
          <div class="stat-value">{{ stats.today }}</div>
        </div>
      </div>

      <!-- 筛选区 -->
      <div class="card">
        <!-- 日志类型：分段控件 -->
        <div class="segmented mb-12">
          <button
            v-for="t in logTypes"
            :key="t.value"
            class="segmented-item"
            :class="{ active: filters.log_type === t.value }"
            @click="switchType(t.value)"
          >{{ t.label }}</button>
        </div>

        <div class="filter-grid">
          <div class="form-group mb-8">
            <label>业务分类</label>
            <select v-model="filters.category" class="form-select" @change="query(1)">
              <option value="">全部分类</option>
              <option v-for="(label, key) in categoryLabels" :key="key" :value="key">{{ label }}</option>
            </select>
          </div>
          <div class="form-group mb-8">
            <label>结果状态</label>
            <select v-model="filters.status" class="form-select" @change="query(1)">
              <option value="">全部状态</option>
              <option value="success">成功</option>
              <option value="failure">失败</option>
            </select>
          </div>
          <div class="form-group mb-8">
            <label>开始日期</label>
            <input v-model="filters.date_from" type="date" class="form-input" @change="query(1)" />
          </div>
          <div class="form-group mb-8">
            <label>结束日期</label>
            <input v-model="filters.date_to" type="date" class="form-input" @change="query(1)" />
          </div>
          <div class="form-group mb-8 filter-keyword">
            <label>关键字（摘要 / 对象 / 操作者 / 路径）</label>
            <div class="flex gap-8">
              <input
                v-model="filters.keyword"
                class="form-input"
                placeholder="输入关键字后回车查询"
                @keyup.enter="query(1)"
              />
              <button class="btn btn-primary" @click="query(1)">查询</button>
              <button class="btn btn-secondary" @click="resetFilters">重置</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 日志列表 -->
      <div class="card">
        <div class="flex-between mb-8">
          <span class="card-title" style="margin-bottom:0">
            共 {{ total }} 条记录
            <span class="text-muted text-xs" v-if="total > 0">（第 {{ page }} / {{ totalPages }} 页）</span>
          </span>
        </div>

        <div class="task-list" v-if="list.length > 0">
          <div class="log-item" v-for="log in list" :key="log.id" @click="toggle(log.id)">
            <div class="log-main">
              <div class="log-summary">
                <span class="badge" :class="log.log_type === 'system' ? 'badge-system' : 'badge-user'">
                  {{ log.log_type === 'system' ? '系统' : '用户' }}
                </span>
                <span class="badge" :class="log.status === 'failure' ? 'badge-fail' : 'badge-completed'">
                  {{ log.status === 'failure' ? '失败' : '成功' }}
                </span>
                <span class="log-text">{{ log.summary || actionLabel(log.action) }}</span>
              </div>
              <div class="task-meta">
                <span>{{ log.created_at }}</span>
                <span>{{ categoryLabels[log.category] || log.category || '其他' }}</span>
                <span>{{ actionLabel(log.action) }}</span>
                <span>操作者：{{ log.operator || '系统' }}</span>
                <span v-if="log.target_id">对象：{{ log.target_id }}</span>
                <span v-if="log.duration_ms != null">耗时 {{ log.duration_ms }}ms</span>
                <span v-if="log.status_code">HTTP {{ log.status_code }}</span>
              </div>
            </div>
            <span class="expand-icon">{{ expanded === log.id ? '▲' : '▼' }}</span>
          </div>
        </div>
        <div class="empty-state" v-else>
          <p class="text-muted text-sm">{{ loading ? '加载中…' : '暂无符合条件的日志' }}</p>
        </div>

        <!-- 详情展开 -->
        <div class="log-detail" v-if="expandedLog">
          <div class="flex-between mb-8">
            <span class="font-bold text-sm">详情 #{{ expandedLog.id }}</span>
            <button class="btn btn-sm btn-secondary" @click="expanded = null">收起</button>
          </div>
          <div class="detail-grid text-xs">
            <div><span class="text-muted">请求方法：</span>{{ expandedLog.method || '-' }}</div>
            <div><span class="text-muted">请求路径：</span>{{ expandedLog.path || '-' }}</div>
            <div><span class="text-muted">操作者角色：</span>{{ expandedLog.operator_role || '-' }}</div>
            <div><span class="text-muted">来源 IP：</span>{{ expandedLog.ip || '-' }}</div>
            <div class="detail-full"><span class="text-muted">User-Agent：</span>{{ expandedLog.user_agent || '-' }}</div>
          </div>
          <pre class="detail-json">{{ prettyDetail(expandedLog.detail) }}</pre>
        </div>

        <!-- 分页 -->
        <div class="flex-between mt-12" v-if="total > 0">
          <div class="flex gap-8">
            <button class="btn btn-sm btn-secondary" :disabled="page <= 1" @click="query(page - 1)">上一页</button>
            <button class="btn btn-sm btn-secondary" :disabled="page >= totalPages" @click="query(page + 1)">下一页</button>
          </div>
          <div class="flex gap-8" style="align-items:center">
            <span class="text-muted text-xs">每页</span>
            <select v-model.number="pageSize" class="form-select page-size" @change="query(1)">
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- 清理历史日志 -->
    <div class="modal-overlay" :class="{ show: showCleanup }" @click.self="showCleanup = false">
      <div class="modal">
        <div class="modal-header">
          <h2>清理历史日志</h2>
          <button class="modal-close" @click="showCleanup = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>保留最近多少天的日志</label>
            <input v-model.number="keepDays" type="number" min="0" class="form-input" />
            <p class="text-muted text-xs mt-8">
              早于该天数的日志将被永久删除，不可恢复。填 0 表示清空全部日志。
            </p>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showCleanup = false">取消</button>
          <button class="btn btn-danger" @click="doCleanup">确认清理</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import request from '@/utils/request'
import Navbar from '@/components/Navbar.vue'

const logTypes = [
  { value: '', label: '全部日志' },
  { value: 'system', label: '系统日志' },
  { value: 'user', label: '用户操作日志' }
]

// 与后端 lib/audit.js 的 category / action 取值保持一致
const categoryLabels = {
  auth: '认证', task: '任务', user: '用户', email: '邮件', settings: '设置',
  reminder: '提醒', cron: '定时任务', storage: '存储', data: '数据',
  audit: '审计', other: '其他'
}
const actionLabels = {
  login: '登录', change_password: '修改密码',
  create: '新增', update: '编辑', delete: '删除',
  update_status: '更新状态', update_progress: '更新进度', update_document: '编辑文档',
  update_config: '保存配置', test_send: '测试发信', update_reminder: '保存提醒设置',
  manual_trigger: '手动触发', save: '保存', sync: '同步', import_excel: '导入 Excel',
  invoke: '任务调用', execute: '任务执行', skip: '跳过', send: '发送邮件', cleanup: '清理日志'
}
const actionLabel = (a) => actionLabels[a] || a || '-'

const loading = ref(false)
const list = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const expanded = ref(null)
const showCleanup = ref(false)
const keepDays = ref(90)
const stats = ref({ total: 0, system: 0, user: 0, failure: 0, today: 0 })

const filters = ref({
  log_type: '', category: '', status: '', keyword: '', date_from: '', date_to: ''
})

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const expandedLog = computed(() => list.value.find((l) => l.id === expanded.value) || null)

const toggle = (id) => { expanded.value = expanded.value === id ? null : id }

const switchType = (t) => {
  filters.value.log_type = t
  query(1)
}

const prettyDetail = (detail) => {
  if (!detail) return '（无详情）'
  try {
    return JSON.stringify(JSON.parse(detail), null, 2)
  } catch (e) {
    return detail
  }
}

const query = async (p = 1) => {
  loading.value = true
  expanded.value = null
  try {
    const params = { page: p, pageSize: pageSize.value }
    Object.entries(filters.value).forEach(([k, v]) => { if (v) params[k] = v })
    const res = await request.get('/audit-logs', { params })
    list.value = res.list || []
    total.value = res.total || 0
    page.value = res.page || p
  } catch (err) {
    alert(err.error || '加载日志失败')
  } finally {
    loading.value = false
  }
}

const loadStats = async () => {
  try {
    stats.value = await request.get('/audit-logs/stats')
  } catch (err) {}
}

const loadAll = async () => { await Promise.all([query(page.value), loadStats()]) }

const resetFilters = () => {
  filters.value = { log_type: filters.value.log_type, category: '', status: '', keyword: '', date_from: '', date_to: '' }
  query(1)
}

const doCleanup = async () => {
  if (!confirm(`确定要删除 ${keepDays.value} 天前的所有日志？此操作不可恢复。`)) return
  try {
    const r = await request.delete('/audit-logs', { params: { keepDays: keepDays.value } })
    showCleanup.value = false
    alert(r.message || '清理完成')
    loadAll()
  } catch (err) {
    alert(err.error || '清理失败')
  }
}

onMounted(loadAll)
</script>

<style scoped>
.audit-page { min-height: 100vh; }

/* 分段控件（日志类型切换） */
.segmented {
  display: inline-flex;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}
.segmented-item {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.segmented-item:hover { color: var(--text); }
.segmented-item.active { background: var(--primary); color: #fff; font-weight: 500; }

.filter-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0 12px;
}
.filter-keyword { grid-column: 1 / -1; }
.page-size { width: auto; padding: 4px 8px; }

/* 日志条目 */
.log-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.02);
  border: 1px solid var(--border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.log-item:hover { background: rgba(255, 255, 255, 0.05); border-color: var(--primary); }
.log-main { flex: 1; min-width: 0; }
.log-summary { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
.log-text { font-size: 13px; font-weight: 500; }
.expand-icon { color: var(--text-secondary); font-size: 10px; }

.badge-system { background: rgba(139, 92, 246, 0.15); color: #a78bfa; }
.badge-user { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
.badge-fail { background: rgba(239, 68, 68, 0.15); color: #f87171; }

/* 详情 */
.log-detail {
  margin-top: 12px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 6px 12px;
  margin-bottom: 8px;
}
.detail-full { grid-column: 1 / -1; word-break: break-all; }
.detail-json {
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

@media (max-width: 768px) {
  .segmented { width: 100%; }
  .segmented-item { flex: 1; padding: 6px 8px; font-size: 12px; }
}
</style>

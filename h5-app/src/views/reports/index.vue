<template>
  <div class="reports-page">
    <nav class="navbar">
      <a href="#" class="navbar-brand">
        <span class="logo">📋</span>
        <span>闻道任务跟踪系统</span>
      </a>
      <div class="navbar-links">
        <a href="#/dashboard">仪表盘</a>
        <a href="#/tasks">任务管理</a>
        <a href="#/reports" class="active">报表中心</a>
        <a href="#/settings">邮件配置</a>
        <a href="#/admin" v-if="user?.role === 'admin'">账号管理</a>
        <a href="#" @click.prevent="logout">退出</a>
      </div>
    </nav>

    <div class="container">
      <div class="flex-between mb-12">
        <div>
          <h1 class="page-title">报表中心</h1>
          <p class="page-subtitle">任务完成汇总与分析</p>
        </div>
        <div class="flex gap-8">
          <select v-model="reportType" class="form-select" style="width: auto;">
            <option value="weekly">周报</option>
            <option value="monthly">月报</option>
          </select>
          <button class="btn btn-primary" @click="loadReport">生成报表</button>
        </div>
      </div>

      <div v-if="loading" class="empty-state">
        <p class="text-muted text-sm" style="text-align: center; padding: 40px;">加载中...</p>
      </div>

      <template v-else-if="report">
        <!-- 概览 -->
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">📊</div>
            <div class="stat-label">总任务数</div>
            <div class="stat-value">{{ report.totalTasks }}</div>
          </div>
          <div class="stat-card success">
            <div class="stat-icon">✅</div>
            <div class="stat-label">已完成</div>
            <div class="stat-value">{{ report.completedTasks }}</div>
          </div>
          <div class="stat-card warning" v-if="report.inProgressTasks !== undefined">
            <div class="stat-icon">⏳</div>
            <div class="stat-label">进行中</div>
            <div class="stat-value">{{ report.inProgressTasks }}</div>
          </div>
          <div class="stat-card purple" v-if="report.pendingTasks !== undefined">
            <div class="stat-icon">📌</div>
            <div class="stat-label">待开始</div>
            <div class="stat-value">{{ report.pendingTasks }}</div>
          </div>
        </div>

        <!-- 完成率 -->
        <div class="card mt-12">
          <div class="flex-between mb-12">
            <div class="card-title">📈 完成率</div>
            <span class="font-bold" style="color: var(--primary); font-size: 18px;">{{ report.completionRate }}%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: report.completionRate + '%' }"></div>
          </div>
        </div>

        <!-- 分类统计 -->
        <div class="card mt-12" v-if="report.categories && Object.keys(report.categories).length > 0">
          <div class="card-title">📊 分类统计</div>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;">
            <div v-for="(stats, cat) in report.categories" :key="cat" style="background: var(--bg); border-radius: 8px; padding: 12px;">
              <div class="flex-between mb-12">
                <span class="font-bold text-sm">{{ cat }}</span>
                <span class="text-muted text-xs">{{ stats.completed }}/{{ stats.total }}</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" :style="{ width: (stats.total > 0 ? Math.round(stats.completed / stats.total * 100) : 0) + '%' }"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- 任务列表 -->
        <div class="card mt-12">
          <div class="card-title">📋 任务列表</div>
          <div class="task-list" v-if="report.tasks?.length > 0">
            <div class="task-item" v-for="task in report.tasks" :key="task.task_id" @click="goDetail(task.task_id)">
              <div class="task-info">
                <div class="task-name">{{ task.name }}</div>
                <div class="task-meta">
                  <span>{{ task.task_id }}</span>
                  <span v-if="task.category">{{ task.category }}</span>
                  <span v-if="task.owner">👤 {{ task.owner }}</span>
                  <span class="badge" :class="statusClass(task.status)">{{ statusText(task.status) }}</span>
                </div>
              </div>
            </div>
          </div>
          <p class="text-muted text-sm" v-else>暂无任务</p>
        </div>

        <!-- 操作日志 -->
        <div class="card mt-12" v-if="report.logs?.length > 0">
          <div class="card-title">📜 操作日志</div>
          <div class="task-list">
            <div class="task-item" v-for="log in report.logs" :key="log.id">
              <div class="task-info">
                <div class="task-name">{{ log.action }}</div>
                <div class="task-meta">
                  <span>{{ log.content }}</span>
                  <span>{{ log.operator }}</span>
                  <span>{{ log.created_at }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import request from '@/utils/request'

const router = useRouter()
const user = ref(JSON.parse(localStorage.getItem('user') || '{}'))
const reportType = ref('weekly')
const report = ref(null)
const loading = ref(false)

const statusClass = (s) => s === 'completed' ? 'badge-completed' : s === 'in_progress' ? 'badge-in_progress' : 'badge-pending'
const statusText = (s) => s === 'completed' ? '已完成' : s === 'in_progress' ? '进行中' : '待开始'

const loadReport = async () => {
  loading.value = true
  try {
    const endpoint = reportType.value === 'weekly' ? '/reports/weekly' : '/reports/monthly'
    report.value = await request.get(endpoint)
  } catch (err) {
    console.error(err)
  } finally {
    loading.value = false
  }
}

const goDetail = (id) => router.push(`/task/${id}`)
const logout = () => {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  router.push('/login')
}

onMounted(loadReport)
</script>

<style scoped>
.reports-page { min-height: 100vh; }
</style>

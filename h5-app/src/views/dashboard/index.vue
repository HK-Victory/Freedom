<template>
  <div class="dashboard-page">
    <nav class="navbar">
      <a href="#" class="navbar-brand">
        <span class="logo">📋</span>
        <span>闻道任务跟踪系统</span>
      </a>
      <div class="navbar-links">
        <a href="#/dashboard" class="active">仪表盘</a>
        <a href="#/tasks">任务管理</a>
        <a href="#/reports">报表中心</a>
        <a href="#/settings">邮件配置</a>
        <a href="#/admin" v-if="user?.role === 'admin'">账号管理</a>
        <a href="#" @click.prevent="logout">退出</a>
      </div>
    </nav>

    <div class="container">
      <div class="flex-between mb-12">
        <div>
          <h1 class="page-title">项目仪表盘</h1>
          <p class="page-subtitle">闻道包装设计工作室创业计划</p>
        </div>
        <a href="#/tasks" class="btn btn-primary">📋 管理任务</a>
      </div>

      <!-- 统计卡片 -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-icon">📊</div>
          <div class="stat-label">总任务数</div>
          <div class="stat-value">{{ total }}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-icon">✅</div>
          <div class="stat-label">已完成</div>
          <div class="stat-value">{{ completed }}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-icon">⏳</div>
          <div class="stat-label">进行中</div>
          <div class="stat-value">{{ inProgress }}</div>
        </div>
        <div class="stat-card purple">
          <div class="stat-icon">📌</div>
          <div class="stat-label">待开始</div>
          <div class="stat-value">{{ pending }}</div>
        </div>
      </div>

      <!-- 完成率 -->
      <div class="card">
        <div class="flex-between mb-12">
          <div class="card-title">📈 整体完成进度</div>
          <span class="font-bold" style="color: var(--primary); font-size: 18px;">{{ completionRate }}%</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" :style="{ width: completionRate + '%' }"></div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <div class="card">
          <div class="card-title">⏰ 即将到期（7天内）</div>
          <div class="task-list">
            <div class="task-item" v-for="t in upcoming" :key="t.task_id" @click="goTask(t.task_id)">
              <div class="task-info">
                <div class="task-name">{{ t.name }}</div>
                <div class="task-meta">
                  <span>{{ t.task_id }}</span>
                  <span>还剩{{ t.days_left }}天</span>
                </div>
              </div>
            </div>
            <p class="text-muted text-sm" v-if="upcoming.length === 0">暂无</p>
          </div>
        </div>
        <div class="card">
          <div class="card-title">🚨 已逾期</div>
          <div class="task-list">
            <div class="task-item" v-for="t in overdue" :key="t.task_id" @click="goTask(t.task_id)">
              <div class="task-info">
                <div class="task-name">{{ t.name }}</div>
                <div class="task-meta">
                  <span>{{ t.task_id }}</span>
                  <span>逾期{{ Math.abs(t.days_left) }}天</span>
                </div>
              </div>
            </div>
            <p class="text-muted text-sm" v-if="overdue.length === 0">暂无</p>
          </div>
        </div>
      </div>

      <!-- 分类统计 -->
      <div class="card mt-12">
        <div class="card-title">📊 任务分类统计</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px;">
          <div v-for="(stats, cat) in categories" :key="cat" style="background: var(--bg); border-radius: 8px; padding: 12px;">
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
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import request from '@/utils/request'

const router = useRouter()
const user = ref(JSON.parse(localStorage.getItem('user') || '{}'))
const total = ref(0)
const completed = ref(0)
const inProgress = ref(0)
const pending = ref(0)
const upcoming = ref([])
const overdue = ref([])
const categories = ref({})

const completionRate = computed(() => total.value > 0 ? Math.round(completed.value / total.value * 100) : 0)

const loadData = async () => {
  try {
    const data = await request.get('/dashboard')
    total.value = data.total
    completed.value = data.completed
    inProgress.value = data.inProgress
    pending.value = data.pending
    upcoming.value = data.upcoming
    overdue.value = data.overdue
    categories.value = data.categories
  } catch (err) {
    console.error(err)
  }
}

const goTask = (id) => router.push(`/task/${id}`)
const logout = () => {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  router.push('/login')
}

onMounted(loadData)
</script>

<style scoped>
.dashboard-page { min-height: 100vh; }
@media (max-width: 768px) {
  .dashboard-page .navbar-links a { padding: 6px 8px; font-size: 12px; }
}
</style>

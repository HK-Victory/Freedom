<template>
  <div class="tasks-page">
    <nav class="navbar">
      <a href="#" class="navbar-brand">
        <span class="logo">📋</span>
        <span>闻道任务跟踪系统</span>
      </a>
      <div class="navbar-links">
        <a href="#/dashboard">仪表盘</a>
        <a href="#/tasks" class="active">任务管理</a>
        <a href="#/reports">报表中心</a>
        <a href="#/settings">邮件配置</a>
        <a href="#/admin" v-if="user?.role === 'admin'">账号管理</a>
        <a href="#" @click.prevent="logout">退出</a>
      </div>
    </nav>

    <div class="container">
      <div class="flex-between mb-12">
        <div>
          <h1 class="page-title">任务管理</h1>
          <p class="page-subtitle" v-if="tasks.length > 0">共 {{ filteredTasks.length }} / {{ tasks.length }} 项任务</p>
        </div>
        <div class="flex gap-8">
          <button class="btn btn-secondary" v-if="user?.role === 'admin'" @click="showImport = true">📂 导入Excel</button>
          <button class="btn btn-primary" @click="openCreate">➕ 新增任务</button>
        </div>
      </div>

      <!-- 筛选 -->
      <div class="card">
        <div class="flex gap-12" style="flex-wrap: wrap;">
          <select v-model="statusFilter" class="form-select" style="width: auto;">
            <option value="">全部状态</option>
            <option value="pending">待开始</option>
            <option value="in_progress">进行中</option>
            <option value="completed">已完成</option>
          </select>
          <select v-model="categoryFilter" class="form-select" style="width: auto;">
            <option value="">全部分类</option>
            <option v-for="cat in categories" :key="cat" :value="cat">{{ cat }}</option>
          </select>
          <input v-model="searchText" class="form-input" placeholder="搜索任务..." style="flex: 1; min-width: 120px;" />
        </div>
      </div>

      <!-- 任务列表 -->
      <div class="task-list mt-12" v-if="filteredTasks.length > 0">
        <div class="task-item" v-for="task in filteredTasks" :key="task.task_id" @click="goDetail(task.task_id)">
          <div class="task-priority" :class="priorityClass(task.priority)"></div>
          <div class="task-info">
            <div class="task-name">{{ task.name }}</div>
            <div class="task-meta">
              <span>{{ task.task_id }}</span>
              <span v-if="task.category">{{ task.category }}</span>
              <span v-if="task.owner">👤 {{ task.owner }}</span>
              <span class="badge" :class="statusClass(task.status)">{{ statusText(task.status) }}</span>
            </div>
          </div>
          <div class="countdown" v-if="task.days_left !== null && task.status !== 'completed'" :class="countdownClass(task.days_left)">
            {{ task.days_left < 0 ? '逾期' + Math.abs(task.days_left) + '天' : '剩' + task.days_left + '天' }}
          </div>
          <div class="flex gap-8" style="margin-left: 8px;">
            <button class="btn btn-sm btn-secondary" @click.stop="editTask(task)">编辑</button>
            <button class="btn btn-sm btn-danger" @click.stop="deleteTask(task)">删除</button>
          </div>
        </div>
      </div>
      <div class="empty-state" v-else>
        <p class="text-muted text-sm" style="text-align: center; padding: 40px;">未找到任务</p>
      </div>
    </div>

    <!-- 模态框 -->
    <div class="modal-overlay" :class="{ show: showEdit }" @click.self="showEdit = false">
      <div class="modal">
        <div class="modal-header">
          <h2>{{ editingTask ? '编辑任务' : '新增任务' }}</h2>
          <button class="modal-close" @click="showEdit = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>任务ID *</label>
            <input v-model="form.task_id" class="form-input" :disabled="!!editingTask" placeholder="如 T022" />
          </div>
          <div class="form-group">
            <label>任务名称 *</label>
            <input v-model="form.name" class="form-input" placeholder="输入任务名称" />
          </div>
          <div class="flex gap-12">
            <div class="form-group" style="flex: 1;">
              <label>分类</label>
              <input v-model="form.category" class="form-input" placeholder="如：内容创作" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label>优先级</label>
              <select v-model="form.priority" class="form-select">
                <option value="高">高</option>
                <option value="中" selected>中</option>
                <option value="低">低</option>
              </select>
            </div>
          </div>
          <div class="flex gap-12">
            <div class="form-group" style="flex: 1;">
              <label>开始日期</label>
              <input type="date" v-model="form.start_date" class="form-input" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label>截止日期</label>
              <input type="date" v-model="form.end_date" class="form-input" />
            </div>
          </div>
          <div class="flex gap-12">
            <div class="form-group" style="flex: 1;">
              <label>责任人</label>
              <input v-model="form.owner" class="form-input" placeholder="负责人" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label>状态</label>
              <select v-model="form.status" class="form-select">
                <option value="pending">待开始</option>
                <option value="in_progress">进行中</option>
                <option value="completed">已完成</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>任务要求</label>
            <textarea v-model="form.requirements" class="form-textarea" placeholder="详细要求..."></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showEdit = false">取消</button>
          <button class="btn btn-primary" @click="saveTask">保存</button>
        </div>
      </div>
    </div>

    <!-- Excel导入模态框 -->
    <div class="modal-overlay" :class="{ show: showImport }" @click.self="showImport = false">
      <div class="modal">
        <div class="modal-header">
          <h2>导入Excel重置</h2>
          <button class="modal-close" @click="showImport = false">✕</button>
        </div>
        <div class="modal-body">
          <p style="color: var(--warning); font-size: 13px; margin-bottom: 16px;">⚠️ 导入将清空所有现有任务、文档、进度记录和里程碑，不可撤销。</p>
          <input type="file" accept=".xlsx,.xls" @change="importExcel" />
          <p v-if="importResult" style="margin-top: 12px; font-size: 13px;">{{ importResult }}</p>
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
const tasks = ref([])
const statusFilter = ref('')
const categoryFilter = ref('')
const searchText = ref('')
const showEdit = ref(false)
const showImport = ref(false)
const editingTask = ref(null)
const importResult = ref('')
const form = ref({})
const categories = computed(() => [...new Set(tasks.value.map(t => t.category).filter(Boolean))])

const filteredTasks = computed(() => {
  let list = tasks.value
  if (statusFilter.value) list = list.filter(t => t.status === statusFilter.value)
  if (categoryFilter.value) list = list.filter(t => t.category === categoryFilter.value)
  if (searchText.value.trim()) {
    const s = searchText.value.toLowerCase()
    list = list.filter(t => t.name.toLowerCase().includes(s) || t.task_id.toLowerCase().includes(s))
  }
  return list
})

const loadTasks = async () => {
  try {
    tasks.value = await request.get('/tasks')
  } catch (err) {}
}

const priorityClass = (p) => p === '高' ? 'high' : p === '中' ? 'medium' : 'low'
const statusClass = (s) => s === 'completed' ? 'badge-completed' : s === 'in_progress' ? 'badge-in_progress' : 'badge-pending'
const statusText = (s) => s === 'completed' ? '已完成' : s === 'in_progress' ? '进行中' : '待开始'
const countdownClass = (d) => d < 0 ? 'overdue' : d <= 7 ? 'urgent' : 'normal'

const openCreate = () => {
  editingTask.value = null
  const maxNum = tasks.value.reduce((max, t) => {
    const m = t.task_id && t.task_id.match(/T0*(\d+)/)
    return m ? Math.max(max, parseInt(m[1])) : max
  }, 0)
  form.value = {
    task_id: 'T' + String(maxNum + 1).padStart(3, '0'),
    name: '', category: '', priority: '中',
    start_date: '', end_date: '', owner: '', status: 'pending', requirements: ''
  }
  showEdit.value = true
}

const editTask = (task) => {
  editingTask.value = task
  form.value = { ...task }
  showEdit.value = true
}

const saveTask = async () => {
  if (!form.value.task_id || !form.value.name) return
  try {
    if (editingTask.value) {
      await request.put(`/tasks/${editingTask.value.task_id}`, form.value)
    } else {
      await request.post('/tasks', form.value)
    }
    showEdit.value = false
    loadTasks()
  } catch (err) {}
}

const deleteTask = async (task) => {
  if (!confirm(`确定要删除「${task.name}」？`)) return
  try {
    await request.delete(`/tasks/${task.task_id}`)
    loadTasks()
  } catch (err) {}
}

const importExcel = async (e) => {
  const file = e.target.files[0]
  if (!file) return
  const formData = new FormData()
  formData.append('file', file)
  try {
    const res = await request.post('/import-excel', formData, { headers: { 'Content-Type': 'multipart/form-data' } })
    importResult.value = res.message || '导入成功'
    loadTasks()
  } catch (err) {
    importResult.value = '导入失败'
  }
}

const goDetail = (id) => router.push(`/task/${id}`)
const logout = () => {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  router.push('/login')
}

onMounted(loadTasks)
</script>

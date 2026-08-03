<template>
  <div class="task-detail-page">
    <Navbar active="tasks" />

    <div class="container">
      <div class="flex-between mb-12">
        <div>
          <a href="#/tasks" class="text-muted text-sm" style="display: inline-flex; align-items: center; gap: 4px;">
            ← 返回任务列表
          </a>
          <h1 class="page-title mt-8">{{ task.name || '加载中...' }}</h1>
          <p class="page-subtitle">{{ task.task_id }} · {{ task.category }}</p>
        </div>
        <div class="flex gap-8">
          <button class="btn btn-secondary" @click="openEdit">✏️ 编辑</button>
          <button class="btn btn-danger" @click="handleDelete">🗑️ 删除</button>
        </div>
      </div>

      <div v-if="loading" class="empty-state">
        <p class="text-muted text-sm" style="text-align: center; padding: 40px;">加载中...</p>
      </div>

      <template v-else>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
          <!-- 基本信息 -->
          <div class="card">
            <div class="card-title">📋 基本信息</div>
            <div class="info-grid">
              <div class="info-item">
                <span class="info-label">状态</span>
                <span class="badge" :class="statusClass(task.status)">{{ statusText(task.status) }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">优先级</span>
                <span>{{ task.priority }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">责任人</span>
                <span>{{ task.owner || '-' }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">分类</span>
                <span>{{ task.category || '-' }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">开始日期</span>
                <span>{{ task.start_date || '-' }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">截止日期</span>
                <span>{{ task.end_date || '-' }}</span>
              </div>
              <div class="info-item">
                <span class="info-label">剩余天数</span>
                <span :class="countdownClass(task.days_left)">
                  {{ task.days_left < 0 ? '逾期' + Math.abs(task.days_left) + '天' : '剩' + task.days_left + '天' }}
                </span>
              </div>
              <div class="info-item">
                <span class="info-label">依赖</span>
                <span>{{ task.dependency || '-' }}</span>
              </div>
            </div>
          </div>

          <!-- 进度更新 -->
          <div class="card">
            <div class="card-title">📈 进度更新</div>
            <div class="form-group">
              <label>更新进度 (%)</label>
              <input type="number" v-model.number="progressForm.progress" min="0" max="100" class="form-input" />
            </div>
            <div class="form-group">
              <label>备注</label>
              <textarea v-model="progressForm.note" class="form-textarea" placeholder="进度说明..."></textarea>
            </div>
            <button class="btn btn-primary" @click="updateProgress">更新进度</button>

            <div class="mt-12" v-if="task.progress_history?.length > 0">
              <div class="text-sm font-bold mb-8">历史记录</div>
              <div class="task-list">
                <div class="task-item" v-for="p in task.progress_history" :key="p.id">
                  <div class="task-info">
                    <div class="task-name">{{ p.progress }}%</div>
                    <div class="task-meta">
                      <span>{{ p.note }}</span>
                      <span>{{ p.recorded_at }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 任务要求 -->
        <div class="card mt-12">
          <div class="card-title">📝 任务要求</div>
          <p style="white-space: pre-wrap; color: #94a3b8; font-size: 13px;">{{ task.requirements || '暂无' }}</p>
        </div>

        <!-- 任务文档 -->
        <div class="card mt-12">
          <div class="card-title">📄 任务文档</div>
          <textarea v-model="document" class="form-textarea" style="min-height: 200px;" placeholder="编辑任务文档..."></textarea>
          <div class="flex-between mt-8">
            <span class="text-muted text-xs" v-if="docUpdated">最后保存: {{ docUpdated }}</span>
            <button class="btn btn-primary" @click="saveDocument">保存文档</button>
          </div>
        </div>

        <!-- 操作日志 -->
        <div class="card mt-12">
          <div class="card-title">📜 操作日志</div>
          <div class="task-list" v-if="task.logs?.length > 0">
            <div class="task-item" v-for="log in task.logs" :key="log.id">
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
          <p class="text-muted text-sm" v-else>暂无操作记录</p>
        </div>
      </template>
    </div>

    <!-- 编辑模态框 -->
    <div class="modal-overlay" :class="{ show: showEdit }" @click.self="showEdit = false">
      <div class="modal">
        <div class="modal-header">
          <h2>编辑任务</h2>
          <button class="modal-close" @click="showEdit = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>任务名称 *</label>
            <input v-model="editForm.name" class="form-input" />
          </div>
          <div class="flex gap-12">
            <div class="form-group" style="flex: 1;">
              <label>分类</label>
              <input v-model="editForm.category" class="form-input" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label>优先级</label>
              <select v-model="editForm.priority" class="form-select">
                <option value="高">高</option>
                <option value="中">中</option>
                <option value="低">低</option>
              </select>
            </div>
          </div>
          <div class="flex gap-12">
            <div class="form-group" style="flex: 1;">
              <label>开始日期</label>
              <input type="date" v-model="editForm.start_date" class="form-input" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label>截止日期</label>
              <input type="date" v-model="editForm.end_date" class="form-input" />
            </div>
          </div>
          <div class="flex gap-12">
            <div class="form-group" style="flex: 1;">
              <label>责任人</label>
              <input v-model="editForm.owner" class="form-input" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label>状态</label>
              <select v-model="editForm.status" class="form-select">
                <option value="pending">待开始</option>
                <option value="in_progress">进行中</option>
                <option value="completed">已完成</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>任务要求</label>
            <textarea v-model="editForm.requirements" class="form-textarea"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showEdit = false">取消</button>
          <button class="btn btn-primary" @click="saveEdit">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import request from '@/utils/request'
import Navbar from '@/components/Navbar.vue'

const router = useRouter()
const route = useRoute()
const user = ref(JSON.parse(localStorage.getItem('user') || '{}'))
const task = ref({})
const loading = ref(true)
const showEdit = ref(false)
const document = ref('')
const docUpdated = ref('')
const editForm = ref({})
const progressForm = ref({ progress: 0, note: '' })

const statusClass = (s) => s === 'completed' ? 'badge-completed' : s === 'in_progress' ? 'badge-in_progress' : 'badge-pending'
const statusText = (s) => s === 'completed' ? '已完成' : s === 'in_progress' ? '进行中' : '待开始'
const countdownClass = (d) => d < 0 ? 'overdue' : d <= 7 ? 'urgent' : 'normal'

const loadTask = async () => {
  try {
    const data = await request.get(`/tasks/${route.params.id}`)
    task.value = data
    document.value = data.document || ''
    progressForm.value.progress = 0
  } catch (err) {
    console.error(err)
  } finally {
    loading.value = false
  }
}

const saveDocument = async () => {
  try {
    const res = await request.put(`/tasks/${route.params.id}/document`, {
      content: document.value,
      updated_by: user.value.display_name || user.value.username
    })
    docUpdated.value = res.updated_at
  } catch (err) {}
}

const updateProgress = async () => {
  if (progressForm.value.progress < 0 || progressForm.value.progress > 100) return
  try {
    await request.put(`/tasks/${route.params.id}/progress`, progressForm.value)
    progressForm.value = { progress: 0, note: '' }
    loadTask()
  } catch (err) {}
}

// 打开编辑框时，用当前任务数据预填表单。否则 editForm 为空对象，
// v-model 会把未填写的字段变成空字符串发出去，后端 COALESCE('', field) 会把这些字段清空。
const openEdit = () => {
  const t = task.value || {}
  editForm.value = {
    name: t.name || '',
    category: t.category || '',
    priority: t.priority || '中',
    start_date: t.start_date || '',
    end_date: t.end_date || '',
    owner: t.owner || '',
    status: t.status || 'pending',
    requirements: t.requirements || ''
  }
  showEdit.value = true
}

const saveEdit = async () => {
  try {
    await request.put(`/tasks/${route.params.id}`, editForm.value)
    showEdit.value = false
    loadTask()
  } catch (err) {}
}

const handleDelete = async () => {
  if (!confirm(`确定要删除「${task.value.name}」？`)) return
  try {
    await request.delete(`/tasks/${route.params.id}`)
    router.push('/tasks')
  } catch (err) {}
}

onMounted(loadTask)
</script>

<style scoped>
.task-detail-page { min-height: 100vh; }
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.info-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.info-label {
  font-size: 11px;
  color: #94a3b8;
  text-transform: uppercase;
}
</style>

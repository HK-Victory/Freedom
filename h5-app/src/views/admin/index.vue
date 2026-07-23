<template>
  <div class="admin-page">
    <nav class="navbar">
      <a href="#" class="navbar-brand">
        <span class="logo">📋</span>
        <span>闻道任务跟踪系统</span>
      </a>
      <div class="navbar-links">
        <a href="#/dashboard">仪表盘</a>
        <a href="#/tasks">任务管理</a>
        <a href="#/reports">报表中心</a>
        <a href="#/settings">邮件配置</a>
        <a href="#/admin" class="active">账号管理</a>
        <a href="#" @click.prevent="logout">退出</a>
      </div>
    </nav>

    <div class="container">
      <div class="flex-between mb-12">
        <div>
          <h1 class="page-title">账号管理</h1>
          <p class="page-subtitle">管理系统用户</p>
        </div>
        <button class="btn btn-primary" @click="openCreate">➕ 新增用户</button>
      </div>

      <!-- 用户列表 -->
      <div class="card">
        <div class="task-list" v-if="users.length > 0">
          <div class="task-item" v-for="u in users" :key="u.id">
            <div class="task-info">
              <div class="task-name">{{ u.display_name || u.username }}</div>
              <div class="task-meta">
                <span>{{ u.username }}</span>
                <span class="badge" :class="u.role === 'admin' ? 'badge-completed' : 'badge-pending'">
                  {{ u.role === 'admin' ? '超管' : '普通用户' }}
                </span>
                <span class="badge" :class="u.enabled ? 'badge-completed' : 'badge-pending'">
                  {{ u.enabled ? '启用' : '禁用' }}
                </span>
              </div>
            </div>
            <div class="flex gap-8">
              <button class="btn btn-sm btn-secondary" @click="editUser(u)">编辑</button>
              <button class="btn btn-sm btn-secondary" @click="toggleEnable(u)">
                {{ u.enabled ? '禁用' : '启用' }}
              </button>
              <button class="btn btn-sm btn-danger" @click="deleteUser(u)" v-if="u.id !== currentUser.id">删除</button>
            </div>
          </div>
        </div>
        <p class="text-muted text-sm" v-else>暂无用户</p>
      </div>
    </div>

    <!-- 新增/编辑模态框 -->
    <div class="modal-overlay" :class="{ show: showEdit }" @click.self="showEdit = false">
      <div class="modal">
        <div class="modal-header">
          <h2>{{ editingUser ? '编辑用户' : '新增用户' }}</h2>
          <button class="modal-close" @click="showEdit = false">✕</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label>用户名 *</label>
            <input v-model="form.username" class="form-input" :disabled="!!editingUser" placeholder="登录账号" />
          </div>
          <div class="form-group">
            <label>显示名称</label>
            <input v-model="form.display_name" class="form-input" placeholder="显示名称" />
          </div>
          <div class="form-group" v-if="!editingUser">
            <label>密码 *</label>
            <input v-model="form.password" type="password" class="form-input" placeholder="至少6位" />
          </div>
          <div class="form-group" v-else>
            <label>新密码 (留空则不修改)</label>
            <input v-model="form.password" type="password" class="form-input" placeholder="至少6位" />
          </div>
          <div class="form-group">
            <label>角色</label>
            <select v-model="form.role" class="form-select">
              <option value="user">普通用户</option>
              <option value="admin">超管</option>
            </select>
          </div>
          <div class="form-group" v-if="editingUser">
            <label>状态</label>
            <select v-model="form.enabled" class="form-select">
              <option :value="true">启用</option>
              <option :value="false">禁用</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="showEdit = false">取消</button>
          <button class="btn btn-primary" @click="saveUser">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import request from '@/utils/request'

const router = useRouter()
const currentUser = ref(JSON.parse(localStorage.getItem('user') || '{}'))
const users = ref([])
const showEdit = ref(false)
const editingUser = ref(null)
const form = ref({ username: '', display_name: '', password: '', role: 'user', enabled: true })

const loadUsers = async () => {
  try {
    users.value = await request.get('/users')
  } catch (err) {}
}

const openCreate = () => {
  editingUser.value = null
  form.value = { username: '', display_name: '', password: '', role: 'user', enabled: true }
  showEdit.value = true
}

const editUser = (u) => {
  editingUser.value = u
  form.value = {
    username: u.username,
    display_name: u.display_name || '',
    password: '',
    role: u.role,
    enabled: u.enabled
  }
  showEdit.value = true
}

const saveUser = async () => {
  try {
    if (editingUser.value) {
      const payload = {
        display_name: form.value.display_name,
        role: form.value.role,
        enabled: form.value.enabled
      }
      if (form.value.password) payload.password = form.value.password
      await request.put(`/users/${editingUser.value.id}`, payload)
    } else {
      await request.post('/users', {
        username: form.value.username,
        password: form.value.password,
        display_name: form.value.display_name,
        role: form.value.role
      })
    }
    showEdit.value = false
    loadUsers()
  } catch (err) {
    alert(err.error || '保存失败')
  }
}

const toggleEnable = async (u) => {
  try {
    await request.put(`/users/${u.id}`, { enabled: !u.enabled })
    loadUsers()
  } catch (err) {
    alert(err.error || '操作失败')
  }
}

const deleteUser = async (u) => {
  if (!confirm(`确定要删除用户「${u.display_name || u.username}」？`)) return
  try {
    await request.delete(`/users/${u.id}`)
    loadUsers()
  } catch (err) {
    alert(err.error || '删除失败')
  }
}

const logout = () => {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  router.push('/login')
}

onMounted(loadUsers)
</script>

<style scoped>
.admin-page { min-height: 100vh; }
</style>

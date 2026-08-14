<template>
  <nav class="navbar">
    <a href="#" class="navbar-brand">
      <span class="logo">📋</span>
      <span>闻道任务跟踪系统</span>
    </a>
    <div class="navbar-links">
      <a href="#/dashboard" :class="{ active: active === 'dashboard' }">仪表盘</a>
      <a href="#/tasks" :class="{ active: active === 'tasks' }">任务管理</a>
      <a href="#/reports" :class="{ active: active === 'reports' }">报表中心</a>
      <a href="#/settings" :class="{ active: active === 'settings' }">设置</a>
      <a href="#/admin" :class="{ active: active === 'admin' }" v-if="isAdmin">账号管理</a>
      <a href="#/audit" :class="{ active: active === 'audit' }" v-if="isAdmin">审计日志</a>
      <a href="#" @click.prevent="logout">退出</a>
    </div>
  </nav>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'

const props = defineProps({
  active: { type: String, default: '' }
})

const router = useRouter()
const user = JSON.parse(localStorage.getItem('user') || '{}')
const isAdmin = computed(() => user?.role === 'admin')

const logout = () => {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  router.push('/login')
}
</script>

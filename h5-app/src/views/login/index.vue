<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">📋</div>
        <h1>闻道任务跟踪系统</h1>
        <p>闻道包装设计工作室</p>
      </div>
      <form @submit.prevent="handleLogin">
        <div class="form-group">
          <label>用户名</label>
          <input v-model="username" class="form-input" placeholder="请输入用户名" required autocomplete="username" />
        </div>
        <div class="form-group">
          <label>密码</label>
          <input v-model="password" type="password" class="form-input" placeholder="请输入密码" required autocomplete="current-password" />
        </div>
        <div v-if="errorMsg" class="error-text">{{ errorMsg }}</div>
        <button type="submit" class="btn btn-primary btn-block" :disabled="loading">登 录</button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import request from '@/utils/request'

const router = useRouter()
const username = ref('')
const password = ref('')
const errorMsg = ref('')

const handleLogin = async () => {
  if (!username.value.trim() || !password.value.trim()) {
    errorMsg.value = '请输入用户名和密码'
    return
  }
  try {
    const res = await request.post('/auth/login', { username: username.value, password: password.value })
    if (res.success) {
      localStorage.setItem('token', res.token)
      localStorage.setItem('user', JSON.stringify(res.user))
      router.push('/dashboard')
    } else {
      errorMsg.value = res.error || '登录失败'
    }
  } catch (err) {
    errorMsg.value = err.error || '登录失败'
  }
}
</script>

<style scoped>
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
  padding: 20px;
}
.login-card {
  width: 100%;
  max-width: 400px;
  background: #1e293b;
  border-radius: 16px;
  padding: 36px 28px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.5);
}
.login-header { text-align: center; margin-bottom: 28px; }
.login-logo {
  width: 60px; height: 60px; margin: 0 auto 12px;
  background: linear-gradient(135deg, #3b82f6, #8b5cf6);
  border-radius: 16px; display: flex; align-items: center; justify-content: center;
  font-size: 32px;
}
.login-header h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
.login-header p { font-size: 12px; color: #94a3b8; }
.form-group { margin-bottom: 14px; }
.form-label {
  display: block; font-size: 12px; color: #94a3b8; margin-bottom: 4px;
}
.form-input {
  width: 100%; background: #0f172a; border: 1px solid #334155;
  border-radius: 8px; padding: 12px 14px; color: #e2e8f0; font-size: 14px;
}
.btn-block {
  width: 100%; background: #3b82f6; color: white; border: none;
  border-radius: 8px; padding: 12px; font-size: 15px; font-weight: 600;
  margin-top: 8px;
}
.error-text { color: #ef4444; font-size: 12px; margin-bottom: 10px; }
</style>

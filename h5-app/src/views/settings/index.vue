<template>
  <div class="settings-page">
    <Navbar active="settings" />

    <div class="container">
      <div class="flex-between mb-12">
        <div>
        <h1 class="page-title">系统设置</h1>
        <p class="page-subtitle">邮件通知与系统配置</p>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
        <!-- SMTP配置 -->
        <div class="card">
          <div class="card-title">📧 SMTP服务器配置</div>
          <div class="form-group">
            <label>SMTP服务器</label>
            <input v-model="config.smtp_host" class="form-input" placeholder="如 smtp.qq.com" />
          </div>
          <div class="flex gap-12">
            <div class="form-group" style="flex: 1;">
              <label>端口</label>
              <input v-model.number="config.smtp_port" type="number" class="form-input" placeholder="465" />
            </div>
            <div class="form-group" style="flex: 1;">
              <label>加密</label>
              <select v-model="config.smtp_secure" class="form-select">
                <option :value="1">SSL</option>
                <option :value="0">无</option>
              </select>
            </div>
          </div>
          <div class="form-group">
            <label>用户名</label>
            <input v-model="config.smtp_user" class="form-input" placeholder="邮箱账号" />
          </div>
          <div class="form-group">
            <label>密码/授权码</label>
            <input v-model="config.smtp_pass" type="password" class="form-input" placeholder="******" />
          </div>
          <div class="form-group">
            <label>发件人名称</label>
            <input v-model="config.sender_name" class="form-input" placeholder="闻道任务提醒" />
          </div>
          <div class="form-group">
            <label>启用邮件</label>
            <select v-model="config.enabled" class="form-select">
              <option :value="1">启用</option>
              <option :value="0">禁用</option>
            </select>
          </div>
          <div class="flex gap-8">
            <button class="btn btn-primary" @click="saveConfig">保存配置</button>
            <button class="btn btn-secondary" @click="testEmail">发送测试</button>
          </div>
          <p v-if="saveMsg" class="text-muted text-xs mt-8">{{ saveMsg }}</p>
        </div>

        <!-- 收件人管理 -->
        <div class="card">
          <div class="card-title">👥 收件人管理</div>
          <div class="flex gap-8 mb-12">
            <input v-model="newRecipient.email" class="form-input" placeholder="邮箱地址" style="flex: 2;" />
            <input v-model="newRecipient.name" class="form-input" placeholder="姓名" style="flex: 1;" />
            <button class="btn btn-primary" @click="addRecipient">添加</button>
          </div>

          <div class="task-list" v-if="recipients.length > 0">
            <div class="task-item" v-for="r in recipients" :key="r.id">
              <div class="task-info">
                <div class="task-name">{{ r.email }}</div>
                <div class="task-meta">
                  <span>{{ r.name }}</span>
                  <span class="badge" :class="r.enabled ? 'badge-completed' : 'badge-pending'">{{ r.enabled ? '启用' : '禁用' }}</span>
                </div>
              </div>
              <div class="flex gap-8">
                <button class="btn btn-sm btn-secondary" @click="toggleRecipient(r)">
                  {{ r.enabled ? '禁用' : '启用' }}
                </button>
                <button class="btn btn-sm btn-danger" @click="deleteRecipient(r)">删除</button>
              </div>
            </div>
          </div>
          <p class="text-muted text-sm" v-else>暂无收件人</p>
        </div>

        <!-- 定时提醒设置（仅超管） -->
        <div class="card" v-if="user?.role === 'admin'">
          <div class="card-title">⏰ 定时提醒设置</div>
          <p class="text-muted text-sm mb-12">配置任务到期提醒邮件的每日执行时间与提前天数（北京时间）。Vercel Cron 每小时触发一次，仅在命中配置时间且任务剩余天数匹配时发送。</p>
          <div class="form-group">
            <label>启用定时提醒</label>
            <select v-model="reminder.enabled" class="form-select">
              <option :value="1">启用</option>
              <option :value="0">禁用</option>
            </select>
          </div>
          <div class="form-group">
            <label>每日执行时间（北京时间）</label>
            <div class="flex gap-8 align-center">
              <input v-model.number="reminder.hour" type="number" min="0" max="23" class="form-input" style="width: 80px;" />
              <span>时</span>
              <span class="text-muted text-xs">（Vercel 免费版定时任务按整点触发，建议填整点）</span>
            </div>
          </div>
          <div class="form-group">
            <label>提前提醒天数（任务截止前 N 天发送）</label>
            <div class="flex gap-12 flex-wrap">
              <label class="checkbox-label" v-for="d in leadDayOptions" :key="d">
                <input type="checkbox" :value="d" v-model="reminder.leadDays" /> {{ d }} 天
              </label>
            </div>
          </div>
          <button class="btn btn-primary" @click="saveReminder">保存提醒设置</button>
          <p v-if="reminderMsg" class="text-muted text-xs mt-8">{{ reminderMsg }}</p>
        </div>
      </div>

      <!-- 修改密码 -->
      <div class="card mt-12" style="max-width: 400px;">
        <div class="card-title">🔒 修改登录密码</div>
        <p class="text-muted text-sm mb-12">用于修改您当前账号的登录密码，修改成功后需重新登录。</p>
        <div class="form-group">
          <label>旧密码</label>
          <input v-model="pwdForm.old_password" type="password" class="form-input" />
        </div>
        <div class="form-group">
          <label>新密码</label>
          <input v-model="pwdForm.new_password" type="password" class="form-input" />
        </div>
        <button class="btn btn-primary" @click="changePassword">修改密码</button>
        <p v-if="pwdMsg" class="text-muted text-xs mt-8">{{ pwdMsg }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import request from '@/utils/request'
import Navbar from '@/components/Navbar.vue'

const user = ref(JSON.parse(localStorage.getItem('user') || '{}'))
const config = ref({
  smtp_host: '', smtp_port: 465, smtp_user: '', smtp_pass: '',
  smtp_secure: 1, sender_name: '', enabled: 0
})
const recipients = ref([])
const newRecipient = ref({ email: '', name: '' })
const saveMsg = ref('')
const pwdForm = ref({ old_password: '', new_password: '' })
const pwdMsg = ref('')

// 定时提醒设置
const reminder = ref({ enabled: 0, hour: 9, leadDays: [1, 3, 7] })
const reminderMsg = ref('')
const leadDayOptions = [1, 2, 3, 5, 7]

const loadConfig = async () => {
  try {
    const data = await request.get('/email/config')
    config.value = {
      smtp_host: data.smtp_host || '',
      smtp_port: data.smtp_port || 465,
      smtp_user: data.smtp_user || '',
      smtp_pass: data.smtp_pass || '',
      smtp_secure: data.smtp_secure !== undefined ? data.smtp_secure : 1,
      sender_name: data.sender_name || '',
      enabled: data.enabled || 0
    }
  } catch (err) {}
}

const loadRecipients = async () => {
  try {
    recipients.value = await request.get('/email/recipients')
  } catch (err) {}
}

const saveConfig = async () => {
  try {
    await request.post('/email/config', config.value)
    saveMsg.value = '配置已保存'
    setTimeout(() => saveMsg.value = '', 3000)
  } catch (err) {
    saveMsg.value = '保存失败'
  }
}

const testEmail = async () => {
  const email = prompt('请输入测试收件邮箱')
  if (!email) return
  try {
    await request.post('/email/test', { to: email })
    saveMsg.value = '测试邮件已发送'
  } catch (err) {
    saveMsg.value = '发送失败: ' + (err.error || '')
  }
}

const addRecipient = async () => {
  if (!newRecipient.value.email) return
  try {
    await request.post('/email/recipients', newRecipient.value)
    newRecipient.value = { email: '', name: '' }
    loadRecipients()
  } catch (err) {}
}

const toggleRecipient = async (r) => {
  try {
    await request.put(`/email/recipients/${r.id}`, { ...r, enabled: !r.enabled })
    loadRecipients()
  } catch (err) {}
}

const deleteRecipient = async (r) => {
  if (!confirm(`确定要删除 ${r.email}？`)) return
  try {
    await request.delete(`/email/recipients/${r.id}`)
    loadRecipients()
  } catch (err) {}
}

const changePassword = async () => {
  if (!pwdForm.value.old_password || !pwdForm.value.new_password) return
  try {
    await request.post('/auth/change-password', pwdForm.value)
    pwdMsg.value = '密码修改成功'
    pwdForm.value = { old_password: '', new_password: '' }
  } catch (err) {
    pwdMsg.value = err.error || '修改失败'
  }
}

const loadReminder = async () => {
  try {
    const d = await request.get('/settings/reminder')
    reminder.value = {
      enabled: d.enabled ? 1 : 0,
      hour: d.hour ?? 9,
      leadDays: Array.isArray(d.leadDays) && d.leadDays.length ? d.leadDays : [1, 3, 7]
    }
  } catch (err) {}
}

const saveReminder = async () => {
  try {
    await request.put('/settings/reminder', {
      enabled: reminder.value.enabled ? true : false,
      hour: Number(reminder.value.hour) || 0,
      minute: 0,
      leadDays: reminder.value.leadDays
    })
    reminderMsg.value = '提醒设置已保存'
    setTimeout(() => reminderMsg.value = '', 3000)
  } catch (err) {
    reminderMsg.value = '保存失败：' + (err.error || '')
  }
}

onMounted(() => {
  loadConfig()
  loadRecipients()
  loadReminder()
})
</script>

<style scoped>
.settings-page { min-height: 100vh; }
.align-center { align-items: center; }
.flex-wrap { flex-wrap: wrap; }
.checkbox-label { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }
</style>

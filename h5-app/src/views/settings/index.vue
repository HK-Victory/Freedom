<template>
  <div class="settings-page">
    <Navbar active="settings" />

    <div class="container">
      <div class="page-header">
        <div>
          <h1 class="page-title">系统设置</h1>
          <p class="page-subtitle">邮件通知与系统配置</p>
        </div>
      </div>

      <!-- 持久化告警：保存数据后若未真正落盘到 Blob，立即提示，避免「假成功真丢失」 -->
      <div v-if="persistWarn" class="alert-banner alert-danger">
        ⚠️ {{ persistWarn }}
      </div>

      <!-- 邮件通知区 -->
      <div class="settings-grid">
        <!-- SMTP配置 -->
        <section class="card">
          <header class="card-head">
            <span class="card-icon icon-blue">📧</span>
            <h2 class="card-title">SMTP 服务器配置</h2>
          </header>
          <div class="form-group">
            <label>SMTP 服务器</label>
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
            <label>密码 / 授权码</label>
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
        </section>

        <!-- 收件人管理 -->
        <section class="card">
          <header class="card-head">
            <span class="card-icon icon-green">👥</span>
            <h2 class="card-title">收件人管理</h2>
          </header>
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
        </section>
      </div>

      <!-- 定时提醒设置 + 修改密码 同一行 -->
      <div class="settings-grid mt-16">
        <!-- 定时提醒设置（仅超管） -->
        <section class="card" v-if="user?.role === 'admin'">
          <header class="card-head">
            <span class="card-icon icon-amber">⏰</span>
            <h2 class="card-title">定时提醒设置</h2>
          </header>
          <p class="text-muted text-sm mb-12">配置任务到期提醒邮件的每日执行时间与提前天数（北京时间）。定时任务每小时触发一次，仅在命中配置时间且任务剩余天数匹配时发送。也可点击下方按钮立即手动触发一次。</p>
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
          <div class="flex gap-8">
            <button class="btn btn-primary" @click="saveReminder">保存提醒设置</button>
            <button class="btn btn-secondary" @click="triggerReminder" :disabled="triggering">
              {{ triggering ? '触发中…' : '立即触发一次' }}
            </button>
          </div>
          <p v-if="reminderMsg" class="text-muted text-xs mt-8">{{ reminderMsg }}</p>
        </section>

        <!-- 修改密码 -->
        <section class="card" :class="{ 'span-2': user?.role !== 'admin' }">
          <header class="card-head">
            <span class="card-icon icon-purple">🔒</span>
            <h2 class="card-title">修改登录密码</h2>
          </header>
          <p class="text-muted text-sm mb-12">用于修改您当前账号的登录密码，修改成功后需重新登录。</p>
          <div class="form-group">
            <label>旧密码</label>
            <input v-model="pwdForm.old_password" type="password" class="form-input" />
          </div>
          <div class="form-group">
            <label>新密码</label>
            <input v-model="pwdForm.new_password" type="password" class="form-input" />
          </div>
          <button class="btn btn-primary btn-block" @click="changePassword">修改密码</button>
          <p v-if="pwdMsg" class="text-muted text-xs mt-8">{{ pwdMsg }}</p>
        </section>
      </div>

      <!-- 数据存储状态（仅超管） -->
      <div class="mt-16" v-if="user?.role === 'admin'">
        <section class="card">
          <header class="card-head">
            <span class="card-icon icon-blue">💾</span>
            <h2 class="card-title">数据存储状态</h2>
          </header>
          <p class="text-muted text-sm mb-12">
            当前数据持久化方式。若 Blob 未真正连接，每次重新部署都会丢失数据。
            需在 Vercel「Settings → Environment Variables」同时配置
            <code>BLOB_READ_WRITE_TOKEN</code> 与 <code>BLOB_STORE_ID</code>（均勾选 Production 环境）。
          </p>
          <div class="storage-grid">
            <div class="storage-item">
              <span class="storage-label">真实连接</span>
              <span class="badge" :class="(storage.blob && storage.blob.connected) ? 'badge-completed' : 'badge-pending'">
                {{ storage.blob && storage.blob.connected ? '已连通 ✅' : '未连通 ❌' }}
              </span>
            </div>
            <div class="storage-item">
              <span class="storage-label">BLOB_TOKEN</span>
              <span class="badge" :class="(storage.blob && storage.blob.tokenConfigured) ? 'badge-completed' : 'badge-pending'">
                {{ storage.blob && storage.blob.tokenConfigured ? '已配置' : '缺失' }}
              </span>
            </div>
            <div class="storage-item">
              <span class="storage-label">BLOB_STORE_ID</span>
              <span class="badge" :class="(storage.blob && storage.blob.storeIdConfigured) ? 'badge-completed' : 'badge-pending'">
                {{ storage.blob && storage.blob.storeIdConfigured ? '已配置' : '缺失' }}
              </span>
              <span v-if="storage.blob && storage.blob.storeId" class="storage-value code-sm">{{ storage.blob.storeId }}</span>
            </div>
            <div class="storage-item">
              <span class="storage-label">Blob 中已有快照</span>
              <span class="storage-value">{{ storage.blob && storage.blob.blobExists ? '是' : '否' }}</span>
            </div>
            <div class="storage-item">
              <span class="storage-label">本次加载来源</span>
              <span class="storage-value">{{ loadSourceText }}</span>
            </div>
            <div class="storage-item">
              <span class="storage-label">任务数</span>
              <span class="storage-value">{{ storage.counts ? storage.counts.tasks : '-' }}</span>
            </div>
            <div class="storage-item">
              <span class="storage-label">上次保存结果</span>
              <span class="storage-value" :class="storage.blob && storage.blob.lastSaveOk === false ? 'text-danger' : ''">
                {{ storage.blob && storage.blob.lastSaveOk === true ? '成功 ✅' : (storage.blob && storage.blob.lastSaveOk === false ? '失败 ❌' : '暂无记录') }}<span v-if="storage.blob && storage.blob.lastSaveAt">（{{ formatTime(storage.blob.lastSaveAt) }}）</span>
              </span>
            </div>
          </div>
          <div v-if="storage.blob && storage.blob.connectError" class="storage-error mt-12">
            ⚠️ 连接 Blob 失败：{{ storage.blob.connectError }}
          </div>
          <div v-if="storage.blob && storage.blob.lastSaveOk === false && storage.blob.lastSaveError" class="storage-error mt-8">
            ⚠️ 落盘失败：{{ storage.blob.lastSaveError }}
          </div>
          <div class="flex gap-8 mt-12">
            <button class="btn btn-primary" @click="saveStorage" :disabled="savingStorage">
              {{ savingStorage ? '保存中…' : '立即保存到存储' }}
            </button>
            <button class="btn btn-secondary" @click="loadStorageStatus">刷新状态</button>
          </div>
          <p v-if="storageMsg" class="text-muted text-xs mt-8">{{ storageMsg }}</p>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
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
const triggering = ref(false)
const leadDayOptions = [1, 2, 3, 5, 7]

// 数据存储状态（仅超管可见）
const storage = ref({})
const storageMsg = ref('')
const persistWarn = ref('')
const savingStorage = ref(false)
const loadSourceText = computed(() => {
  const map = {
    blob: 'Vercel Blob（历史数据已恢复 ✅）',
    kv: 'Vercel KV',
    local: '本地文件',
    seed: '内置种子数据',
    embedded: '内联种子数据',
    fresh: '全新空库',
    none: '未知'
  }
  return (storage.value && map[storage.value.loadSource]) || (storage.value && storage.value.loadSource) || '未知'
})
const formatTime = (iso) => {
  try { return new Date(iso).toLocaleString('zh-CN') } catch (e) { return iso }
}

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
    await checkPersist()
  } catch (err) {}
}

const toggleRecipient = async (r) => {
  try {
    await request.put(`/email/recipients/${r.id}`, { ...r, enabled: !r.enabled })
    loadRecipients()
    await checkPersist()
  } catch (err) {}
}

const deleteRecipient = async (r) => {
  if (!confirm(`确定要删除 ${r.email}？`)) return
  try {
    await request.delete(`/email/recipients/${r.id}`)
    loadRecipients()
    await checkPersist()
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
    await checkPersist()
  } catch (err) {
    reminderMsg.value = '保存失败：' + (err.error || '')
  }
}

const triggerReminder = async () => {
  if (triggering.value) return
  triggering.value = true
  reminderMsg.value = ''
  try {
    const r = await request.post('/reminders/trigger')
    reminderMsg.value = `已触发检查：发送 ${r.sent || 0} 封，跳过 ${r.skipped || 0} 条${r.reason ? '（' + r.reason + '）' : ''}`
  } catch (err) {
    reminderMsg.value = '触发失败：' + (err.error || err.message || '')
  } finally {
    triggering.value = false
    setTimeout(() => { reminderMsg.value = '' }, 6000)
  }
}

const loadStorageStatus = async () => {
  try {
    storage.value = await request.get('/storage/status')
  } catch (err) { /* 非超管或无权限时静默 */ }
}

// 写操作后调用：刷新存储状态；若落盘失败则弹出醒目告警，避免「保存成功但刷新丢数据」的假象
const checkPersist = async () => {
  try {
    storage.value = await request.get('/storage/status')
  } catch (err) { /* 非超管或无权限时静默 */ }
  const b = storage.value && storage.value.blob
  if (b && b.lastSaveOk === false) {
    persistWarn.value = '数据已保存，但未持久化到 Blob：' + (b.lastSaveError || '未知原因') +
      '。重新部署将丢失，请到下方「数据存储状态」检查配置（BLOB_READ_WRITE_TOKEN 须配置到 Vercel 运行时）。'
  } else {
    persistWarn.value = ''
  }
}

const saveStorage = async () => {
  if (savingStorage.value) return
  savingStorage.value = true
  try {
    const r = await request.post('/storage/save')
    storage.value = r
    storageMsg.value = r.success ? '已保存到存储' : '保存失败'
  } catch (err) {
    storageMsg.value = '保存失败：' + (err.error || err.message || '')
  } finally {
    savingStorage.value = false
    setTimeout(() => { storageMsg.value = '' }, 3000)
  }
}

onMounted(() => {
  loadConfig()
  loadRecipients()
  loadReminder()
  loadStorageStatus()
})
</script>

<style scoped>
.settings-page { min-height: 100vh; }

/* 页面标题区 */
.page-header { margin-bottom: 16px; }

/* 卡片网格：两列一行 */
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}
.mt-16 { margin-top: 16px; }
.span-2 { grid-column: 1 / -1; }

/* 卡片悬停微交互 */
.settings-page .card {
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.2s;
}
.settings-page .card:hover {
  border-color: rgba(59, 130, 246, 0.45);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}

/* 卡片头部：图标 + 标题 */
.card-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  font-size: 18px;
  flex-shrink: 0;
}
.card-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
  color: var(--text);
}
.icon-blue { background: rgba(59, 130, 246, 0.14); }
.icon-green { background: rgba(34, 197, 94, 0.14); }
.icon-amber { background: rgba(245, 158, 11, 0.16); }
.icon-purple { background: rgba(167, 139, 250, 0.16); }

.align-center { align-items: center; }
.flex-wrap { flex-wrap: wrap; }
.checkbox-label { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; }

/* 数据存储状态 */
.storage-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 4px;
}
.storage-item {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.storage-label { font-size: 12px; color: var(--text-secondary); }
.storage-value { font-size: 14px; font-weight: 600; color: var(--text); }
.card p code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 12px;
  color: #93c5fd;
}
@media (max-width: 768px) {
  .storage-grid { grid-template-columns: repeat(2, 1fr); }
}
.storage-error {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.35);
  color: #fca5a5;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-all;
}
.text-danger { color: #fca5a5; }
.alert-banner {
  border-radius: 12px;
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.5;
  margin-bottom: 16px;
}
.alert-danger {
  background: rgba(239, 68, 68, 0.14);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fecaca;
}
.code-sm {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: #93c5fd;
  word-break: break-all;
}

/* 移动端：单列堆叠 */
@media (max-width: 768px) {
  .settings-grid { grid-template-columns: 1fr; }
}
</style>

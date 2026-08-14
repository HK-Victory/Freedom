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

      <!-- 界面主题与背景颜色（所有用户可自定义） -->
      <div class="settings-grid mt-16">
        <section class="card">
          <header class="card-head">
            <span class="card-icon icon-blue">🎨</span>
            <h2 class="card-title">主题颜色</h2>
          </header>
          <p class="text-muted text-sm mb-12">自定义系统主色调。选择下方预设色卡，或使用取色器自定义；设置保存在本机浏览器，刷新后依然生效。</p>
          <div class="theme-presets">
            <button
              v-for="p in themePresets"
              :key="p.name"
              class="theme-swatch"
              :class="{ active: theme.primary.toLowerCase() === p.primary.toLowerCase() }"
              :style="{ background: p.primary }"
              :title="p.name"
              @click="applyPreset(p)"
            >
              <span v-if="theme.primary.toLowerCase() === p.primary.toLowerCase()" class="swatch-check">✓</span>
            </button>
          </div>
          <div class="flex gap-12 align-center mt-12 flex-wrap">
            <div class="flex align-center gap-8">
              <label class="text-muted text-sm" style="margin: 0;">自定义主色</label>
              <input type="color" v-model="theme.primary" @input="onColorInput" class="color-input" />
            </div>
            <button class="btn btn-secondary" @click="resetTheme">恢复默认</button>
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <span class="card-icon icon-purple">🌈</span>
            <h2 class="card-title">背景颜色</h2>
          </header>
          <p class="text-muted text-sm mb-12">自定义页面背景色。文字与卡片颜色会随背景明暗自动适配，保证可读；选择预设色卡或使用取色器均可。</p>
          <div class="theme-presets">
            <button
              v-for="b in bgPresets"
              :key="b.name"
              class="theme-swatch"
              :class="{ active: theme.bg.toLowerCase() === b.bg.toLowerCase() }"
              :style="{ background: b.bg }"
              :title="b.name"
              @click="applyBgPreset(b)"
            >
              <span v-if="theme.bg.toLowerCase() === b.bg.toLowerCase()" class="swatch-check">✓</span>
            </button>
          </div>
          <div class="flex gap-12 align-center mt-12 flex-wrap">
            <div class="flex align-center gap-8">
              <label class="text-muted text-sm" style="margin: 0;">自定义背景</label>
              <input type="color" v-model="theme.bg" @input="onBgInput" class="color-input" />
            </div>
            <button class="btn btn-secondary" @click="resetTheme">恢复默认</button>
          </div>
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
          <p class="text-muted text-sm mb-12">配置任务到期提醒邮件的发送开关与提前天数（北京时间）。系统由 Vercel Cron 每日 20:00（北京时间）自动触发发送，发送时间由部署配置固定，不可在页面修改。也可点击下方按钮立即手动触发一次。</p>
          <div class="form-group">
            <label>启用定时提醒</label>
            <select v-model="reminder.enabled" class="form-select">
              <option :value="1">启用</option>
              <option :value="0">禁用</option>
            </select>
          </div>
          <div class="form-group">
            <label>每日执行时间（北京时间）</label>
            <p class="text-muted">每日 20:00 自动发送（由 Vercel Cron 固定触发，页面不可修改）</p>
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

      <!-- 数据库 / 存储模式（仅超管可见） -->
      <div class="settings-grid mt-16" v-if="user?.role === 'admin'">
        <section class="card span-2">
          <header class="card-head">
            <span class="card-icon icon-blue">🗄️</span>
            <h2 class="card-title">数据库 / 存储模式</h2>
          </header>
          <p class="text-muted text-sm mb-12">选择系统使用的数据库驱动，可在「云库在线」时预先切到离线验证。仅管理员可配置，普通用户不可见。</p>
          <div class="storage-current mb-12" v-if="status && status.driver">
            <span class="badge" :class="status.driver === 'supabase' ? 'badge-completed' : 'badge-pending'">
              当前驱动：{{ status.driver === 'supabase' ? 'Postgres（云库）' : 'SQLite（本地）' }}
            </span>
            <span class="badge" :class="status.mode === 'offline' ? 'badge-pending' : 'badge-completed'">模式：{{ modeLabel(status.mode) }}</span>
            <span class="badge" v-if="status.envOverride" style="background: rgba(239,68,68,0.16); color:#f87171">FREEDOM_OFFLINE 强制离线</span>
            <span class="badge" v-else-if="status.supabaseConfigured" style="background: rgba(59,130,246,0.14)">已配置 Supabase</span>
            <span class="badge" v-else style="background: rgba(34,197,94,0.14)">未配置 Supabase</span>
          </div>
          <div class="form-group">
            <label>存储模式</label>
            <select v-model="storageMode" class="form-select">
              <option value="auto">自动（推荐：配了云库用 Postgres，否则本地 SQLite）</option>
              <option value="postgres">仅 Postgres（云库）</option>
              <option value="offline">离线（本地 SQLite）</option>
            </select>
          </div>
          <p class="text-muted text-xs mt-8" v-if="storageMode === 'offline'">
            离线模式数据仅进程内，Vercel 冷启动不持久；云平台到期后也可直接设置环境变量 <code>FREEDOM_OFFLINE=1</code> 强制离线。
          </p>
          <div class="flex gap-8 mt-12">
            <button class="btn btn-primary" @click="saveStorage" :disabled="savingStorage">{{ savingStorage ? '保存中…' : '保存存储模式' }}</button>
            <button class="btn btn-secondary" @click="loadStorage">刷新状态</button>
          </div>
          <p v-if="storageMsg" class="text-muted text-xs mt-8">{{ storageMsg }}</p>
        </section>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import request from '@/utils/request'
import Navbar from '@/components/Navbar.vue'
import { loadTheme, saveTheme, PRESET_THEMES, BG_PRESETS, DEFAULT_THEME } from '@/utils/theme'

const user = ref(JSON.parse(localStorage.getItem('user') || '{}'))

// 界面主题与背景颜色（前端本地保存，刷新后生效）
const theme = ref(loadTheme())
const themePresets = PRESET_THEMES
const bgPresets = BG_PRESETS
const applyPreset = (p) => {
  theme.value = saveTheme({
    primary: p.primary,
    accent: p.accent,
    bg: theme.value.bg || DEFAULT_THEME.bg
  })
}
const applyBgPreset = (b) => {
  theme.value = saveTheme({
    primary: theme.value.primary || DEFAULT_THEME.primary,
    accent: theme.value.accent || DEFAULT_THEME.accent,
    bg: b.bg
  })
}
const onColorInput = () => {
  theme.value = saveTheme({
    primary: theme.value.primary,
    accent: theme.value.accent || DEFAULT_THEME.accent,
    bg: theme.value.bg || DEFAULT_THEME.bg
  })
}
const onBgInput = () => {
  theme.value = saveTheme({
    primary: theme.value.primary || DEFAULT_THEME.primary,
    accent: theme.value.accent || DEFAULT_THEME.accent,
    bg: theme.value.bg
  })
}
const resetTheme = () => {
  theme.value = saveTheme({ ...DEFAULT_THEME })
}
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
const reminder = ref({ enabled: 0, leadDays: [1, 3, 7] })
const reminderMsg = ref('')
const triggering = ref(false)
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
      leadDays: Array.isArray(d.leadDays) && d.leadDays.length ? d.leadDays : [1, 3, 7]
    }
  } catch (err) {}
}

const saveReminder = async () => {
  try {
    // 将提前天数统一转为数字，避免字符串/数字混用导致「配置未生效」
    const leadDays = (reminder.value.leadDays || [])
      .map(Number)
      .filter(n => Number.isFinite(n) && n >= 0);
    await request.put('/settings/reminder', {
      enabled: !!reminder.value.enabled,
      leadDays: leadDays.length ? leadDays : [1, 3, 7]
    })
    await loadReminder() // 回读确认保存结果，确保页面与后端一致
    reminderMsg.value = '提醒设置已保存'
    setTimeout(() => reminderMsg.value = '', 3000)
  } catch (err) {
    reminderMsg.value = '保存失败：' + (err.error || '')
  }
}

const triggerReminder = async () => {
  if (triggering.value) return
  triggering.value = true
  reminderMsg.value = ''
  try {
    const r = await request.post('/reminders/trigger', {}, { timeout: 55000 })
    const parts = [`已触发检查：发送 ${r.sent || 0} 封`]
    if (r.overdue) parts.push(`（含逾期 ${r.overdue} 封）`)
    parts.push(`，跳过 ${r.skipped || 0} 条`)
    if (r.reason) parts.push(`（${r.reason}）`)
    reminderMsg.value = parts.join('')
  } catch (err) {
    reminderMsg.value = '触发失败：' + (err.error || err.message || '')
  } finally {
    triggering.value = false
    setTimeout(() => { reminderMsg.value = '' }, 6000)
  }
}

// 数据库 / 存储模式（仅超管）
const storageMode = ref('auto')
const status = ref({ driver: '', mode: 'auto', offline: false, envOverride: false, supabaseConfigured: false })
const savingStorage = ref(false)
const storageMsg = ref('')
const modeLabel = (m) => ({ auto: '自动', postgres: '仅 Postgres', offline: '离线 SQLite' }[m] || m)

const loadStorage = async () => {
  storageMsg.value = ''
  try {
    const s = await request.get('/settings/storage')
    status.value = s
    storageMode.value = s.mode || 'auto'
  } catch (err) {}
}

const saveStorage = async () => {
  if (savingStorage.value) return
  savingStorage.value = true
  storageMsg.value = ''
  try {
    const r = await request.put('/settings/storage', { mode: storageMode.value })
    status.value = r
    storageMode.value = r.mode || storageMode.value
    storageMsg.value = '存储模式已保存：' + modeLabel(r.mode || storageMode.value)
  } catch (err) {
    storageMsg.value = '保存失败：' + (err.error || err.message || '')
  } finally {
    savingStorage.value = false
    setTimeout(() => { storageMsg.value = '' }, 4000)
  }
}


onMounted(() => {
  loadConfig()
  loadRecipients()
  loadReminder()
  loadStorage()
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
  border-color: var(--primary-soft2);
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

/* 存储模式卡片 */
.storage-current { display: flex; flex-wrap: wrap; gap: 8px; }
.storage-current .badge { font-size: 12px; }
code { background: rgba(128, 128, 128, 0.18); padding: 1px 5px; border-radius: 4px; font-size: 12px; color: var(--text); }
.mb-12 { margin-bottom: 12px; }
.mt-12 { margin-top: 12px; }


/* 主题颜色选择 */
.theme-presets { display: flex; flex-wrap: wrap; gap: 12px; }
.theme-swatch {
  width: 40px; height: 40px; border-radius: 10px; border: 2px solid transparent;
  cursor: pointer; position: relative; transition: transform 0.15s, border-color 0.15s;
  display: flex; align-items: center; justify-content: center; color: #fff; font-size: 16px;
}
.theme-swatch:hover { transform: scale(1.08); }
.theme-swatch.active {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--primary);
}
.swatch-check { font-weight: 700; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
.color-input {
  width: 48px; height: 32px; padding: 2px; border: 1px solid var(--border);
  border-radius: 6px; background: var(--bg); cursor: pointer;
}

/* 移动端：单列堆叠 */
@media (max-width: 768px) {
  .settings-grid { grid-template-columns: 1fr; }
}
</style>

/**
 * 主题管理工具
 *
 * 设计：
 *   - 全局样式 style.css 的 :root 已定义 --bg / --surface / --border / --primary / --accent
 *     等 CSS 变量，组件统一通过这些变量取色。
 *   - 本工具把用户自定义的「主题色(primary)」与「背景色(bg)」写入 localStorage，
 *     在运行时覆盖 :root 上的变量：
 *       * primary 派生 hover/active 等半透明变体；
 *       * bg 根据亮度自动派生 --surface / --border / --text / --text-secondary，
 *         保证浅色背景时文字转深、深色背景时文字转浅，任意配色下都可读。
 *   - 数据仅保存在本机浏览器（前端功能），无需后端配合；刷新后由 main.js 在挂载前重新应用。
 */

const STORAGE_KEY = 'freedom_theme'

// 与 style.css :root 默认值保持一致
export const DEFAULT_THEME = {
  primary: '#3b82f6',
  accent: '#8b5cf6',
  bg: '#0f172a'
}

// 预设主题（主色 + 辅助渐变色）
export const PRESET_THEMES = [
  { name: '经典蓝', primary: '#3b82f6', accent: '#8b5cf6' },
  { name: '森林绿', primary: '#22c55e', accent: '#10b981' },
  { name: '魔力紫', primary: '#8b5cf6', accent: '#6366f1' },
  { name: '活力橙', primary: '#f59e0b', accent: '#fb7185' },
  { name: '中国红', primary: '#ef4444', accent: '#f97316' },
  { name: '科技青', primary: '#06b6d4', accent: '#3b82f6' },
  { name: '樱花粉', primary: '#ec4899', accent: '#a855f7' },
  { name: '石墨灰', primary: '#64748b', accent: '#0ea5e9' }
]

// 预设背景（以深色为主，契合当前浅色文字的设计；用户也可用取色器自由选浅色，文字会自动转深）
export const BG_PRESETS = [
  { name: '经典深蓝', bg: '#0f172a' },
  { name: '石墨黑', bg: '#111827' },
  { name: '深空紫', bg: '#1a1030' },
  { name: '墨绿', bg: '#0b1f1a' },
  { name: '暗夜红', bg: '#1f1010' },
  { name: '海军蓝', bg: '#0a1626' },
  { name: '暖灰', bg: '#1c1917' },
  { name: '石板蓝', bg: '#0d1b2a' },
  { name: '暗青', bg: '#06212b' },
  { name: '纯黑', bg: '#000000' }
]

function hexToRgb(hex) {
  let h = (hex || '').replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  if (h.length !== 6) return null
  const num = parseInt(h, 16)
  if (isNaN(num)) return null
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 }
}

function rgba(hex, alpha) {
  const c = hexToRgb(hex)
  if (!c) return null
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`
}

// 在 hex 颜色上向白(amount>0)或向黑(amount<0)混合，返回 rgb() 字符串
function shade(hex, amount) {
  const c = hexToRgb(hex)
  if (!c) return null
  const target = amount < 0 ? 0 : 255
  const p = Math.abs(amount)
  const r = Math.round((target - c.r) * p + c.r)
  const g = Math.round((target - c.g) * p + c.g)
  const b = Math.round((target - c.b) * p + c.b)
  return `rgb(${r}, ${g}, ${b})`
}

// 相对亮度（0~1），>0.5 视为浅色背景
function luminance(hex) {
  const c = hexToRgb(hex)
  if (!c) return 0
  const a = [c.r, c.g, c.b].map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]
}

// 将主题应用到 :root，并派生 hover/active 等半透明变体、以及背景相关的派生变量
export function applyTheme(theme) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) }
  const root = document.documentElement

  // 主题色（主色 + 辅助渐变色）
  root.style.setProperty('--primary', t.primary)
  root.style.setProperty('--accent', t.accent)
  const soft = rgba(t.primary, 0.1)
  const soft2 = rgba(t.primary, 0.45)
  if (soft) root.style.setProperty('--primary-soft', soft)
  if (soft2) root.style.setProperty('--primary-soft2', soft2)

  // 背景色：始终应用，并派生 surface/border/text，保证对比度
  const bg = t.bg || DEFAULT_THEME.bg
  root.style.setProperty('--bg', bg)
  if (luminance(bg) > 0.5) {
    // 浅色背景 → 深色文字，surface/border 向黑混合
    root.style.setProperty('--surface', shade(bg, -0.06))
    root.style.setProperty('--border', shade(bg, -0.12))
    root.style.setProperty('--text', '#0f172a')
    root.style.setProperty('--text-secondary', '#475569')
  } else {
    // 深色背景 → 浅色文字，surface/border 向白混合
    root.style.setProperty('--surface', shade(bg, 0.1))
    root.style.setProperty('--border', shade(bg, 0.18))
    root.style.setProperty('--text', '#e2e8f0')
    root.style.setProperty('--text-secondary', '#94a3b8')
  }
}

export function loadTheme() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_THEME }
    return { ...DEFAULT_THEME, ...JSON.parse(raw) }
  } catch (e) {
    return { ...DEFAULT_THEME }
  }
}

export function saveTheme(theme) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t))
  } catch (e) {
    /* 隐私模式等场景下可能写入失败，忽略 */
  }
  applyTheme(t)
  return t
}

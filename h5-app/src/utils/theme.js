/**
 * 主题色管理工具
 *
 * 设计：
 *   - 全局样式 style.css 的 :root 已定义 --primary / --accent / --primary-soft / --primary-soft2
 *     等 CSS 变量，组件统一通过这些变量取色。
 *   - 本工具把用户自定义的主题色写入 localStorage，并在运行时覆盖 :root 上的变量，
 *     同时根据主色派生出 hover/active 等半透明变体，保证任意主色下对比度都合理。
 *   - 数据仅保存在本机浏览器（前端功能），无需后端配合；刷新后由 main.js 在挂载前重新应用。
 */

const STORAGE_KEY = 'freedom_theme'

// 与 style.css :root 默认值保持一致
export const DEFAULT_THEME = {
  primary: '#3b82f6',
  accent: '#8b5cf6'
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

// 将主题应用到 :root，并派生 hover/active 等半透明变体
export function applyTheme(theme) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) }
  const root = document.documentElement
  root.style.setProperty('--primary', t.primary)
  root.style.setProperty('--accent', t.accent)
  const soft = rgba(t.primary, 0.1)
  const soft2 = rgba(t.primary, 0.45)
  if (soft) root.style.setProperty('--primary-soft', soft)
  if (soft2) root.style.setProperty('--primary-soft2', soft2)
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

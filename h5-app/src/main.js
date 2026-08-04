import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './style.css'
import { loadTheme, applyTheme } from './utils/theme'

// 在挂载前应用已保存的主题色，避免页面闪烁
applyTheme(loadTheme())

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

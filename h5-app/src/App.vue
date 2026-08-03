<template>
  <div id="app">
    <!-- 全局持久化告警：任意写接口落盘失败时（数据可能重部署丢失），所有页面统一弹红色横幅 -->
    <transition name="fade">
      <div v-if="persistWarn" class="global-persist-warn" @click="persistWarn = ''">
        ⚠️ 数据未保存到云端（重新部署/重启将丢失）：{{ persistWarn }}
        <span class="global-persist-warn__close">✕</span>
      </div>
    </transition>
    <router-view />
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const persistWarn = ref('')

const onWarn = (e) => {
  const msg = e?.detail
  if (msg) persistWarn.value = typeof msg === 'string' ? msg : JSON.stringify(msg)
}

onMounted(() => {
  window.addEventListener('app:persist-warning', onWarn)
})
onUnmounted(() => {
  window.removeEventListener('app:persist-warning', onWarn)
})
</script>

<style>
.global-persist-warn {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 9999;
  background: #b91c1c;
  color: #fff;
  font-size: 13px;
  line-height: 1.4;
  padding: 10px 40px 10px 16px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.3);
}
.global-persist-warn__close {
  position: absolute;
  right: 14px; top: 50%;
  transform: translateY(-50%);
  font-size: 14px;
  opacity: .8;
}
.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', sans-serif;
  background: #0f172a;
  color: #e2e8f0;
  min-height: 100vh;
}
#app { min-height: 100vh; }
</style>

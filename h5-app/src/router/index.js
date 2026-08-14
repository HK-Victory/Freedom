import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/login', component: () => import('../views/login/index.vue') },
  { path: '/dashboard', component: () => import('../views/dashboard/index.vue'), meta: { auth: true } },
  { path: '/tasks', component: () => import('../views/tasks/index.vue'), meta: { auth: true } },
  { path: '/task/:id', component: () => import('../views/task-detail/index.vue'), meta: { auth: true } },
  { path: '/reports', component: () => import('../views/reports/index.vue'), meta: { auth: true } },
  { path: '/settings', component: () => import('../views/settings/index.vue'), meta: { auth: true } },
  { path: '/admin', component: () => import('../views/admin/index.vue'), meta: { auth: true, adminOnly: true } },
  { path: '/audit', component: () => import('../views/audit/index.vue'), meta: { auth: true, adminOnly: true } }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.beforeEach((to, from, next) => {
  const token = localStorage.getItem('token')
  const user = JSON.parse(localStorage.getItem('user') || '{}')

  if (to.meta.auth && !token) {
    next('/login')
    return
  }

  if (to.meta.adminOnly && user.role !== 'admin') {
    next('/dashboard')
    return
  }

  if (to.path === '/login' && token) {
    next('/dashboard')
    return
  }

  next()
})

export default router

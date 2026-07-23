import axios from 'axios'
import router from '../router'

// 环境自适应 BaseURL
// 开发环境：走 vite proxy → localhost:3000
// 生产环境：同域部署，自动拼接 /api
const baseURL = import.meta.env.DEV ? '/api' : '/api'

const request = axios.create({
  baseURL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' }
})

request.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

request.interceptors.response.use(
  res => res.data,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      router.push('/login')
    }
    return Promise.reject(err.response?.data || err)
  }
)

export default request

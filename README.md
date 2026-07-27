# 闻道包装设计工作室 - 任务跟踪管理系统

基于 Excel 计划书的自动化任务跟踪与协作平台，支持在线文档编辑、邮件倒计时提醒、周/月报导出。

> 已改造为 **EdgeOne Pages Serverless** 部署风格：后端用 `sql.js`（SQLite 纯 JS/WASM，无原生模块）替代 `better-sqlite3`，前端用 Vue 3 + Vite 构建为静态资源，由 EdgeOne Pages 一体化托管。**国内节点直连可达，无需代理。**

## 一键部署（EdgeOne Pages）

推荐通过 **GitHub Actions 自动部署**（见下节）。也可在 EdgeOne Pages 控制台用 Git 集成关联本仓库，构建命令与环境变量如下：

| 配置项 | 值 |
|--------|-----|
| Build Command | `npm run build`（即 `cd h5-app && npm install && npx vite build`） |
| Output Directory | `h5-app/dist` |
| Install Command | `npm install` |
| Node Version | 22.x |

**环境变量（可选）：**

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | JWT 签发密钥 | 自动随机生成（每次冷启动变化，建议固定） |
| `APP_URL` | 部署后的站点地址（用于邮件中的任务链接） | 空（链接回退为相对路径） |
| `CRON_SECRET` | 保护 `/api/cron/reminders` 的密钥（每日提醒定时任务调用时携带） | 空（不校验） |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | 边缘 KV（如 Upstash）地址与令牌，用于跨实例持久化 | 空（仅用 /tmp 文件，单实例有效） |

> ⚠️ 数据持久化说明：EdgeOne Pages Serverless 文件系统为临时态（除 `/tmp`），且实例间不共享。
> 已内置 `data/seed.b64` 作为冷启动初始数据（含 21 项任务与超管账号）。
> 若需要**真正持久化**（写入的数据在多次请求/不同实例间保留），请配置 **KV Storage**，
> 并把 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 填入环境变量，数据库会自动序列化进 KV。

## 自动化部署（GitHub Actions → EdgeOne Pages）

仓库已内置 `.github/workflows/deploy.yml`：每次向 `main` 分支 `push` 即自动构建并部署到 EdgeOne Pages 生产环境。

首次使用需在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中添加如下密钥：

| Secret | 获取方式 |
|--------|----------|
| `EDGEONE_API_TOKEN` | https://edgeone.ai/document/177158578324279296 创建 API Token |
| `EDGEONE_PROJECT_NAME` | （可选）EdgeOne 项目名称，默认 `freedom` |

> 每日 09:00（北京时间）会通过 GitHub Actions 的 `schedule` 触发一次到期提醒：
> 在仓库 Secrets 中添加 `REMINDER_URL`（部署后的 EdgeOne 站点地址，如 `https://freedom-xxx.edgeone.app`），
> 工作流即会自动调用 `/api/cron/reminders` 发送提醒邮件（可选 `CRON_SECRET` 加强鉴权）。

## 本地开发

```bash
# 1. 安装后端依赖
npm install

# 2. 安装并构建前端
cd h5-app && npm install && npm run build && cd ..

# 3. 启动后端（端口 3000，同时托管已构建的 h5-app/dist）
node server.js

# 4.（可选）前端热更新开发服务器（端口 5173，代理 API 到 3000）
cd h5-app && npm run dev
```

访问 http://localhost:3000 即可使用。

## 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 超级管理员 |

## 项目目录结构

```
task-tracker/
├── node-functions/
│   └── api/
│       └── [[default]].js   # EdgeOne Pages Node Functions 入口（包装 Express app，补 /api 前缀 + 等数据库就绪）
├── api/
│   ├── embedded-wasm.js     # 内联的 sql.js WASM（base64，随函数打包，避免 serverless 找不到文件）
│   └── embedded-seed.js     # 内联的种子数据（base64，冷启动兜底）
├── h5-app/                 # Vue 3 + Vite 前端
│   ├── src/
│   │   ├── views/          # 7 个页面视图（login/dashboard/tasks/task-detail/reports/settings/admin）
│   │   ├── router/         # 路由 + 鉴权守卫
│   │   ├── utils/          # axios 请求封装（token 拦截）
│   │   └── style.css       # 全局暗色主题样式
│   ├── package.json
│   └── vite.config.js
├── auth.js                # JWT 认证中间件
├── server.js              # Express 应用 + 全部 API 路由（本地直接 node 启动）
├── db.js                  # sql.js 存储引擎（替代 better-sqlite3，纯 JS/WASM，serverless 友好）
├── excel-reader.js        # Excel 计划书读取、同步与重置导入
├── email.js               # 邮件发送模块
├── scheduler.js           # 定时提醒逻辑（每日提醒由 GitHub Actions schedule 触发）
├── package.json
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Actions：push 自动部署 EdgeOne Pages
├── scripts/
│   └── make-seed.js        # 从 SQLite 导出 seed.b64 初始数据
└── data/
    ├── seed.b64            # 仓库内置初始数据库（必须提交）
    └── uploads/            # Excel 上传临时目录（运行时生成）
```

## 依赖项

| 依赖 | 用途 |
|------|------|
| express | Web 框架（Node Functions 框架模式直接 export 实例） |
| sql.js | 纯 JS/WASM 版 SQLite（serverless 友好，无原生模块） |
| nodemailer | 邮件发送 |
| xlsx | Excel 文件读取 |
| multer | Excel 文件上传处理 |
| jsonwebtoken | JWT 认证令牌签发与验证 |
| bcryptjs | 密码哈希加密 |

## 功能模块

### 1. 用户认证与权限
- **JWT 认证**：登录后获取 token，所有 API 请求需携带 `Authorization: Bearer <token>` 头
- **角色体系**：超管（admin）/普通用户（user），前端 + 后端双重权限校验
- **账号管理页**（超管专属）：创建/编辑/删除用户，分配角色，启用/禁用账号
- **密码修改**：所有用户可修改自己的密码

### 2. 仪表盘
- 任务总数、已完成/进行中/待开始统计卡片
- 整体完成率进度条
- 即将到期任务（7 天内）和已逾期任务预警
- 按分类统计任务分布

### 3. 任务管理
- **筛选搜索**：按状态、分类筛选 + 关键词搜索
- **完整 CRUD**：新增/编辑/删除任务
- **Excel 导入重置**（超管专属）

### 4. 在线文档编辑
- 每项任务对应一个独立可编辑文档
- 多人协作：自动保存 + 手动保存
- 操作日志记录

### 5. 邮件倒计时提醒
- 提前 7 天开始每日提醒（由 GitHub Actions 每日 09:00 触发 `/api/cron/reminders`）
- SMTP 服务器配置（支持 QQ/163/Gmail/企业微信）
- 收件人管理

### 6. 周报 / 月报
- 按周次或月份查询任务完成情况
- 完成率、进度详情、操作日志汇总

## API 接口

所有 API（除登录外）均需携带 `Authorization: Bearer <token>` 请求头。

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | 公开 | 用户登录 |
| GET | `/api/auth/me` | 登录 | 获取当前用户信息 |
| POST | `/api/auth/change-password` | 登录 | 修改密码 |
| GET | `/api/users` | 超管 | 用户列表 |
| POST | `/api/users` | 超管 | 创建用户 |
| PUT | `/api/users/:id` | 超管 | 编辑用户 |
| DELETE | `/api/users/:id` | 超管 | 删除用户 |
| GET | `/api/dashboard` | 登录 | 仪表盘统计数据 |
| GET | `/api/tasks` | 登录 | 任务列表（支持 status/category 筛选） |
| GET | `/api/tasks/:id` | 登录 | 任务详情 |
| POST | `/api/tasks` | 登录 | 创建任务 |
| PUT | `/api/tasks/:id` | 登录 | 编辑任务 |
| DELETE | `/api/tasks/:id` | 登录 | 删除任务 |
| GET | `/api/tasks/:id/document` | 登录 | 获取任务文档 |
| PUT | `/api/tasks/:id/document` | 登录 | 保存任务文档 |
| POST | `/api/import-excel` | 超管 | 上传 Excel 重置数据 |
| GET/PUT/POST | `/api/email/*` | 登录 | 邮件配置与收件人管理 |
| GET | `/api/reports/weekly` | 登录 | 周报 |
| GET | `/api/reports/monthly` | 登录 | 月报 |
| GET | `/api/cron/reminders` | Cron/Secret | 由 GitHub Actions 每日触发的提醒任务 |

## 变更记录

### 2026-07-27 v4.1 — 从 Vercel 迁移到 EdgeOne Pages
- 部署目标由 Vercel 改为 **EdgeOne Pages**（腾讯云，国内节点直连可达，无需代理）
- 新增 `node-functions/api/[[default]].js` 作为 EdgeOne Node Functions 入口：
  - 采用官方「框架模式」直接 `export` Express 实例
  - 平台会把 `/api` 目录前缀从 `req.url` 剥离，入口内补回前缀使路由匹配
  - 冷启动 `await ensureReady()` 加载 sql.js(wasm) + 种子数据
- `db.js` 的 serverless 检测由 `isVercel` 改为通用 `isServerless`（兼容 Vercel/EdgeOne/只读 FS）
- 删除 Vercel 专用文件：`vercel.json`、`api/index.js`
- `.github/workflows/deploy.yml` 改为 `npx edgeone pages deploy ./h5-app/dist -n freedom -t $EDGEONE_API_TOKEN`
- 每日提醒改由 GitHub Actions `schedule` 触发（不再依赖 Vercel Cron）
- `package.json` 移除 `vercel`/`serverless-http` 依赖
- 清理 `.gitignore`：移除已入库的 `h5-app/dist` 与运行时 `data/db.store`（改由 CI 构建）

### 2026-07-23 v4.0 — Vercel 免费 Serverless 改造
- 用 `sql.js`（纯 JS/WASM）替换 `better-sqlite3`，彻底去除原生模块依赖
- `db.js` 提供 better-sqlite3 兼容包装（支持 `@命名参数` 与 `?` 位置参数）
- 内置 `data/seed.b64` 初始数据，冷启动自动载入
- 新增 `.github/workflows/deploy.yml` 实现 push 自动部署
- 全文 29 项功能测试通过（登录/仪表盘/任务CRUD/文档/邮件/用户/报表/提醒）

### 2026-07-22 v3.0 — Vercel 部署改造
- 移除微信小程序相关代码
- 改造 `server.js` 支持导出 app 供 Serverless 调用
- 前端构建输出到 `h5-app/dist`，由平台自动托管

### 2026-07-21 v2.1 — 权限调整 + 启用/禁用
- 移除登录页面默认账号展示
- 邮件配置权限从超管专属改为所有登录用户可访问
- 账号管理添加启用/禁用功能

### 2026-07-21 v2.0 — 账号权限 + 任务管理重构
- 新增 JWT 用户认证系统
- 新增角色权限体系（超管/普通用户）
- 新增账号管理页面
- 任务管理从仪表盘独立出来

### 2026-07-21 v1.1 — 任务 CRUD 扩展
- 新增导入 Excel 重置功能
- 新增手动添加任务功能
- 新增编辑已有任务功能

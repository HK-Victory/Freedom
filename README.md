# 闻道包装设计工作室 - 任务跟踪管理系统

基于 Excel 计划书的自动化任务跟踪与协作平台，支持在线文档编辑、邮件倒计时提醒、周/月报导出。

> 已改造为 **Vercel 免费 Serverless** 部署风格：后端用 `sql.js`（SQLite 纯 JS/WASM，无原生模块）替代 `better-sqlite3`，前端用 Vue 3 + Vite 构建为静态资源，由 Vercel 一体化托管。

## 一键部署（Vercel）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/HK-Victory/Freedom)

或连接 GitHub 仓库后在 Vercel 后台一键导入，构建命令与环境变量如下：

| 配置项 | 值 |
|--------|-----|
| Build Command | `npm run build`（即 `cd h5-app && npm install && npx vite build`） |
| Output Directory | `h5-app/dist` |
| Install Command | `npm install` |
| Node Version | 20.x |

**环境变量（可选）：**

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `JWT_SECRET` | JWT 签发密钥 | 自动随机生成（每次冷启动变化，建议固定） |
| `APP_URL` | 部署后的站点地址（用于邮件中的任务链接） | 空（链接回退为相对路径） |
| `CRON_SECRET` | 保护 `/api/cron/reminders` 的密钥（Vercel Cron 调用时携带） | 空（不校验） |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Vercel KV（Upstash）地址与令牌，用于跨实例持久化 | 空（仅用 /tmp 文件，单实例有效） |

> ⚠️ 数据持久化说明：Vercel Serverless 文件系统只读（除 `/tmp`），且实例间不共享。
> 已内置 `data/seed.b64` 作为冷启动初始数据（含 21 项任务与超管账号）。
> 若需要**真正持久化**（写入的数据在多次请求/不同实例间保留），请在 Vercel 后台创建 **KV Storage**，
> 并把 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 填入环境变量，数据库会自动序列化进 KV。

## 自动化部署（GitHub Actions → Vercel）

仓库已内置 `.github/workflows/deploy.yml`：每次向 `main` 分支 `push` 即自动部署到 Vercel 生产环境。

首次使用需在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中添加三个密钥：

| Secret | 获取方式 |
|--------|----------|
| `VERCEL_TOKEN` | https://vercel.com/account/tokens 创建 |
| `VERCEL_ORG_ID` | `vercel project ls` 或项目设置页的 Team ID |
| `VERCEL_PROJECT_ID` | `vercel project ls` 或项目设置页的 Project ID |

> 若不想配置 Secrets，也可直接在 Vercel 后台用 **Git 集成** 关联该 GitHub 仓库，
> 此后每次 push 同样会自动部署，无需任何 workflow。

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
├── api/
│   └── index.js           # Vercel Serverless Function 入口（包装 Express app）
├── h5-app/                 # Vue 3 + Vite 前端
│   ├── src/
│   │   ├── views/          # 7 个页面视图（login/dashboard/tasks/task-detail/reports/settings/admin）
│   │   ├── router/         # 路由 + 鉴权守卫
│   │   ├── utils/          # axios 请求封装（token 拦截）
│   │   └── style.css       # 全局暗色主题样式
│   ├── package.json
│   └── vite.config.js
├── auth.js                # JWT 认证中间件
├── server.js              # Express 应用 + 全部 API 路由
├── db.js                  # sql.js 存储引擎（替代 better-sqlite3，纯 JS/WASM）
├── excel-reader.js        # Excel 计划书读取、同步与重置导入
├── email.js               # 邮件发送模块
├── scheduler.js           # 定时提醒逻辑（Cron 由 Vercel 接管，详见 vercel.json）
├── vercel.json            # Vercel 部署配置（含 crons）
├── package.json
├── scripts/
│   └── make-seed.js      # 从 SQLite 导出 seed.b64 初始数据
└── data/
    ├── seed.b64           # 仓库内置初始数据库（必须提交）
    └── uploads/           # Excel 上传临时目录（运行时生成）
```

## 依赖项

| 依赖 | 用途 |
|------|------|
| express | Web 框架 |
| sql.js | 纯 JS/WASM 版 SQLite（Vercel 友好，无原生模块） |
| nodemailer | 邮件发送 |
| xlsx | Excel 文件读取 |
| multer | Excel 文件上传处理 |
| jsonwebtoken | JWT 认证令牌签发与验证 |
| bcryptjs | 密码哈希加密 |
| serverless-http | Vercel Serverless 适配 |

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
- 提前 7 天开始每日提醒（由 Vercel Cron 每日触发 `/api/cron/reminders`）
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
| GET | `/api/cron/reminders` | Cron/Secret | 由 Vercel Cron 每日触发的提醒任务 |

## 变更记录

### 2026-07-23 v4.0 — Vercel 免费 Serverless 改造
- 用 `sql.js`（纯 JS/WASM）替换 `better-sqlite3`，彻底去除原生模块依赖
- `db.js` 提供 better-sqlite3 兼容包装（支持 `@命名参数` 与 `?` 位置参数）
- 内置 `data/seed.b64` 初始数据，冷启动自动载入
- 增加 KV（Upstash）持久化支持（可选）
- 新增 `api/index.js` Serverless Function 入口
- `vercel.json` 增加 `crons`（每日提醒）+ `framework:null` + 构建/输出配置
- 定时提醒由 Vercel Cron 接管（移除 node-cron 运行时依赖）
- 移除微信小程序相关代码
- 新增 `.github/workflows/deploy.yml` 实现 push 自动部署 Vercel
- 全文 29 项功能测试通过（登录/仪表盘/任务CRUD/文档/邮件/用户/报表/提醒）

### 2026-07-22 v3.0 — Vercel 部署改造
- 移除微信小程序相关代码
- 新增 Vercel 部署配置 `vercel.json`
- 改造 `server.js` 支持导出 app 供 Vercel 调用
- 前端构建输出到 `h5-app/dist`，由 Vercel 自动托管

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

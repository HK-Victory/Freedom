# Supabase 部署与数据迁移说明

本项目已重构为 **Vercel（前端 + API）+ Supabase Postgres（数据存储）** 架构。
数据以真实的**关系型表**形式存放在 Supabase 上，不再依赖 Vercel Blob 单文件快照，
因此彻底消除了「多实例内存库互相覆盖 / 重部署读不到快照而假丢失」等问题。

## 一、Supabase 侧准备

1. 登录 [supabase.com](https://supabase.com)，新建一个 Project。
2. 进入 **Settings → Database**，在 **Connection string** 区域选择 **URI** 格式，复制连接串：

   ```
   postgresql://postgres:<你的密码>@db.<project-ref>.supabase.co:5432/postgres
   ```

   > 说明：默认直连端口 `5432` 即可。本项目用 `pg` 驱动直连 Supabase Postgres，
   > 不走 Supabase JS 客户端的 REST 层，因此任意 SQL 都能直接执行。

3. （可选）如需更严格的访问控制，可在 Supabase **Authentication → Policies** 中为各表配置 RLS；
   本项目服务端使用全权限的 `postgres` 连接串，未启用 RLS，逻辑权限由应用层（JWT + 角色）控制。

## 二、表结构

**无需手动建表**：应用首次启动时（`ensureReady`）会自动执行 `db.js` 中的
`CREATE TABLE IF NOT EXISTS` 语句，创建以下 11 张表：

- `tasks` / `documents` / `email_config` / `email_recipients`
- `reminders` / `task_logs` / `task_progress`
- `users` / `settings`
- `milestones` / `risks`（由 Excel 同步逻辑使用）

首次启动还会自动创建默认超管账号 **admin / admin123**（请上线后立即修改密码）。

## 三、Vercel 环境变量

在 Vercel 项目 **Settings → Environment Variables** 中（**务必勾选 Production**），
添加：

| 变量名 | 说明 | 示例 |
| --- | --- | --- |
| `SUPABASE_DB_URL` | Supabase Postgres 连接串（URI 格式） | `postgresql://postgres:xxx@db.xxx.supabase.co:5432/postgres` |

> 旧版的 `BLOB_READ_WRITE_TOKEN` / `BLOB_STORE_ID` 已不再需要，可删除。
> `SUPABASE_DB_URL` 也可在 GitHub 仓库的 **Secrets / Variables** 中配置，
> 部署工作流 `.github/workflows/deploy.yml` 会在 `vercel deploy` 时自动注入运行时。

## 四、本地开发

```bash
# 1. 安装依赖（含 pg）
npm install

# 2. 配置本地/测试用 Supabase 连接串
export SUPABASE_DB_URL="postgresql://postgres:xxx@db.xxx.supabase.co:5432/postgres"

# 3. 启动
npm run dev        # 监听 http://localhost:3000
```

未配置 `SUPABASE_DB_URL` 时，服务可启动但所有写操作会报错，并在
**设置 → 数据存储状态** 中显示「连接串缺失」。

## 五、从旧版（Vercel Blob / sql.js）迁移数据

旧数据保存在 Vercel Blob 的 `freedom-db.sqlite` 快照中。迁移脚本
`scripts/migrate-to-supabase.js` 会把旧 sqlite 数据导入新建的 Supabase 表：

```bash
# 方式 A：从本地 sqlite 文件导入（先把旧 Blob 快照下载到本地，例如 freedom-db.sqlite）
SUPABASE_DB_URL="postgresql://postgres:xxx@db.xxx.supabase.co:5432/postgres" \
node scripts/migrate-to-supabase.js --sqlite ./freedom-db.sqlite

# 方式 B：脚本自动从 Vercel Blob 读取（需同时配置旧 Blob 凭据）
BLOB_READ_WRITE_TOKEN="..." SUPABASE_DB_URL="..." \
node scripts/migrate-to-supabase.js --from-blob
```

> 迁移脚本会按 `task_id` / `username` 等自然键做幂等 upsert，重复执行安全。
> 若暂无旧数据，可直接跳过——首次启动即为空库，超管账号自动创建，
> 任务数据可通过 **设置 → Excel 同步 / 导入 Excel** 重新载入。

## 六、功能回归测试（离线，无需真实 Supabase）

为了在不依赖外部 Supabase 实例的情况下验证 SQL 方言翻译、多实例共享、
错误中间件顺序等关键点，项目内置了一个基于 **[PGlite](https://pglite.dev)**
（WASM 版真实 Postgres）的离线功能测试。它通过 `Module._load` 钩子把 `require('pg')`
替换成 PGlite 支撑的假 `Pool`/`Client`，再启动**两个 server.js 实例**共享同一个
PGlite 数据库，精确复现 Vercel「多实例 + 单一 Supabase」的真实拓扑。

```bash
# 首次运行需安装 PGlite 作为开发依赖
npm i -D @electric-sql/pglite

# 运行回归测试（122 项断言，覆盖 17 个分组）
npm test
# 等价于：node scripts/functional-test-supabase.js
```

测试覆盖（全部通过为 `全部通过：122/122`）：

1. 11 张表自动初始化（`CREATE TABLE IF NOT EXISTS`）
2. 注册 / 登录 / JWT 鉴权
3. 存储状态接口（`SUPABASE_DB_URL` 是否配置、连通性、各表行数）
4. 任务 CRUD（含 `RETURNING id` 主键回填）
5. **核心回归：跨实例编辑不互相覆盖**（实例 A 改任务状态，实例 B 读取其它任务不受影响，且新改动立即对 B 可见）
6. 进度 / 状态联动（进度 100% 自动置为已完成）
7. 文档 upsert（`INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`）
8. 提醒设置写入（`settings` 表无 `id` 列，验证不误加 `RETURNING id`）
9. 邮件配置 / 收件人
10. 用户管理（自保护：非超管不能删自己；`RETURNING id` 正确回填）
11. 仪表盘 / 报表聚合
12. 里程碑 / 风险 / 提醒（验证 `date(...) - N days` → `to_char(CURRENT_DATE - ($n)::int, ...)` 日期转型）
13. 定时任务（cron）不报错
14. 级联删除（删任务连带进度 / 日志）
15. 错误处理中间件（异步异常返回 500 JSON，而非挂起）
16. 持久化真实性（两个实例共享同一库，写入对另一实例立即可见）
17. Excel 重置 / 增量导入

> 测试在本地即可运行，不需要任何网络或外部数据库，适合 CI 与本地 PR 校验。
> 若 PGlite 未安装，测试脚本会给出 `npm i -D @electric-sql/pglite` 的明确提示。

## 七、数据持久化机制变化

| 维度 | 旧版（Blob + sql.js） | 新版（Supabase Postgres） |
| --- | --- | --- |
| 存储位置 | Vercel Blob 单文件快照 | Supabase 关系表（11 张） |
| 共享性 | 多实例各自内存库，需快照对账 | 所有实例共享同一 Postgres，天然一致 |
| 写可见性 | 异步落盘，依赖 flush 中间件 | 每次请求内 `await` 实时写入，立即持久化 |
| 重部署 | 需从 Blob 重新加载快照 | 无需加载，数据始终在 Supabase |
| 故障表现 | 静默回退种子/互相覆盖 | 连接失败直接 500，前端可见报错 |

存储状态可在 **设置 → 数据存储状态** 中实时查看（连接串是否配置、是否连通、最近写入结果、各表行数）。

## 八、GitHub Actions 部署变量清单

部署工作流 `.github/workflows/deploy.yml` 在 push 到 `main` 时自动构建并部署到 Vercel。
所有部署配置集中读取自 **GitHub Actions 的 Secrets / Variables**，仓库内不硬编码任何凭据。

**配置入口**：仓库 **Settings → Secrets and variables → Actions**

| 名称 | 存放位置 | 是否必需 | 说明 |
| --- | --- | --- | --- |
| `VERCEL_TOKEN` | Secrets | 必需 | Vercel 部署令牌（https://vercel.com/account/tokens） |
| `SUPABASE_DB_URL` | Secrets 或 Variables | **必需（数据持久化）** | Supabase Postgres 连接串（URI 格式，见下） |
| `VERCEL_PROJECT_NAME` | Variables | 可选（默认 `freedom`） | Vercel 项目名，**必须全小写** |
| `APP_URL` | Variables | 推荐 | 部署后的正式域名，用于邮件提醒链接（如 `https://freedom.vercel.app`） |
| `CRON_SECRET` | Secrets 或 Variables | 可选 | 仅当重新启用 `/api/cron/*` 定时提醒时需要，用于校验调用方 |

> 含密码的项（`VERCEL_TOKEN` / `SUPABASE_DB_URL` / `CRON_SECRET`）建议放 **Secrets** 标签页；
> 工作流对这类项采用 `secrets.X || vars.X` 读取，因此放 Variables 也能生效。
> 非敏感项（`VERCEL_PROJECT_NAME` / `APP_URL`）放 **Variables** 标签页即可。
>
> 工作流对这些变量采用「非空才注入」策略：未配置时部署仍会成功（应用可启动），
> 但缺少 `SUPABASE_DB_URL` 时写操作会报「连接串缺失」、数据不持久。

### SUPABASE_DB_URL 格式

在 Supabase 控制台 **Settings → Database → Connection string** 复制连接串。该页面有两个标签页：

**① Connection pooling（连接池 / PgBouncer）— 推荐用于 Vercel 等外部/Serverless 平台：**

```
postgresql://postgres.<project-ref>:<你的密码>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

- 主机为 `*.pooler.supabase.com`、端口 `6543`、用户名带项目引用（`postgres.<project-ref>`）。
- 该主机**有公网 DNS 解析**，外部平台可直连。
- `db.js` 检测到 `pooler.supabase.com` 主机会自动追加 `?pgbouncer=true`，避免 PgBouncer 事务模式下 `pg` 预编译语句报错，无需手动处理。

**② Direct connection（直连，端口 5432）：**

```
postgresql://postgres:<你的密码>@db.<project-ref>.supabase.co:5432/postgres
```

- ⚠️ **注意**：部分 Supabase 项目的直连主机 `db.<project-ref>.supabase.co` **没有公网 DNS 解析**，从 Vercel 等外部网络会报 `getaddrinfo ENOTFOUND`。若遇此错误，请改用上面的 **Connection pooling** 字符串。
- 本项目实测即为此情况，已切换为 pooler 字符串。

通用说明：

- `db.js` 用 `pg` 驱动直连，并启用 `ssl: { rejectUnauthorized: false }`（Supabase 要求 SSL）。
- 项目同时兼容 `DATABASE_URL` 别名（代码 `SUPABASE_DB_URL || DATABASE_URL`）。
- 未配置时服务可启动，但写操作报「连接串缺失」、数据不持久（前端「设置 → 数据存储状态」可见）。

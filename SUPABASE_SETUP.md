# Supabase 部署与数据存储说明

本项目采用 **Vercel（前端 + API）+ Supabase Postgres（数据存储）** 架构，
数据以真实的**关系型表**形式存放在 Supabase 上，不再依赖 Vercel Blob 单文件快照，
因此彻底消除了「多实例内存库互相覆盖 / 重部署读不到快照而假丢失」等问题。

## 一、连接方式：为什么不用直连串

Supabase 控制台给出的 **Direct connection** 串形如：

```
postgresql://postgres:<密码>@db.<project-ref>.supabase.co:5432/postgres
```

⚠️ 该主机 `db.<project-ref>.supabase.co` **没有公网 DNS A 记录**（本项目实测确认），
从 Vercel 等外部网络访问必然报 `getaddrinfo ENOTFOUND`。

因此本项目**不使用任何 5432 直连**，改为通过
**`@supabase/supabase-js` 客户端 → HTTPS 443 → `exec_sql` RPC** 访问数据库。
REST 主机 `<project-ref>.supabase.co` 有正常公网解析，从任何网络都能访问，
从根本上绕开了直连主机不可解析的问题。

## 二、双驱动架构

`db.js` 对外只暴露一套统一接口，业务代码（`server.js` 等）完全不感知底层是谁：

```js
db.prepare(sql).all(...args)   // 多行
db.prepare(sql).get(...args)   // 单行
db.prepare(sql).run(...args)   // 写入，返回 { changes, lastInsertRowid }
db.exec(sql)                   // 多语句（建表）
```

底层有两个可切换的驱动：

| 驱动 | 何时启用 | 数据持久性 |
| --- | --- | --- |
| **Supabase**（主） | `SUPABASE_URL` + 密钥都已配置，且 `exec_sql` 探活成功 | ✅ 持久 |
| **SQLite**（兜底） | 未配置 Supabase，或连接/探活失败 | ❌ 仅进程内，冷启动即丢 |

> 兜底驱动基于 `sql.js`。它的存在是为了**让服务在数据库不可用时仍能启动并暴露诊断信息**，
> 而不是让你看到一堆 500。生产环境若发现 `driver: "sqlite"`，说明 Supabase 没连上，**数据不会持久**，
> 必须按下方「五、排障」处理。

业务 SQL 统一按 **SQLite 方言**书写，Supabase 模式下由 `db.js` 的翻译层自动转成 Postgres：

| SQLite 写法 | 转换后（Postgres） |
| --- | --- |
| `?` / `@name` 占位符 | `$1..$n` |
| `datetime('now','localtime')` | `to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')` |
| `date('now','localtime','-'\|\|?\|\|' days')` | `to_char(CURRENT_DATE - ($1)::int, 'YYYY-MM-DD')` |
| `INSERT OR IGNORE` | `INSERT ... ON CONFLICT DO NOTHING` |

## 三、部署步骤

### 步骤 1：创建 `exec_sql` 函数（**必做，只需一次**）

打开 Supabase 控制台 → **SQL Editor** → 新建查询 → 把
[`scripts/exec_sql.sql`](scripts/exec_sql.sql) **全文**粘贴执行。

> ⚠️ 文件末尾的 `NOTIFY pgrst, 'reload schema';` **必须一并执行**。
> PostgREST 的 schema 缓存不会立刻感知新函数，漏掉这句会导致函数明明已创建，
> 调用却仍报 `Could not find the function public.exec_sql(params, sql) in the schema cache`。

自检（应返回 `[{"ok":1}]`）：

```sql
SELECT exec_sql('SELECT 1 AS ok', '[]'::jsonb);
```

### 步骤 2：配置部署变量

仓库 **Settings → Secrets and variables → Actions**：

| 名称 | 位置 | 必需 | 说明 |
| --- | --- | --- | --- |
| `VERCEL_TOKEN` | Secrets | ✅ | Vercel 部署令牌（https://vercel.com/account/tokens） |
| `SUPABASE_URL` | Variables 或 Secrets | ✅ | 形如 `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Secrets | 推荐 | 服务角色密钥，权限完整 |
| `SUPABASE_ANON_KEY` | Secrets 或 Variables | 二选一 | 无 service_role 时回退使用 |
| `VERCEL_PROJECT_NAME` | Variables | 可选 | 默认 `freedom`，**必须全小写** |
| `APP_URL` | Variables 或 Secrets | 推荐 | 正式域名，用于邮件提醒链接 |
| `CRON_SECRET` | Secrets 或 Variables | **推荐（建议配置）** | 校验 `/api/cron/*` 调用方。**Vercel Cron 用它对请求签名**，因此必须存在于 Vercel 项目运行时环境变量（经 `deploy.yml` 的 `vercel deploy -e CRON_SECRET=...` 注入）；缺失则 Vercel 不签名、服务端签名校验失败 → 定时提醒 401 |

> **所有 Supabase 相关变量都采用「两个标签页都读」策略**（`vars.X || secrets.X`），
> 放 Variables 还是 Secrets 都能生效。
>
> 这一点曾踩过坑：早期 `SUPABASE_URL` 只读 Variables，而用户把它和密钥一起放进了 Secrets，
> 结果**密钥注入成功、URL 丢失** → `SUPABASE_CONFIGURED=false` → 静默降级 SQLite，
> 排查成本极高。现已两边都读。

### 定时提醒的两条触发链（互为冗余）
- **① Vercel Cron**：`vercel.json` 的 `crons` 字段声明 `GET /api/cron/reminders`（UTC `0 * * * *`，每小时第 0 分钟）。Vercel 用项目 `CRON_SECRET` 对请求做 HMAC 签名，服务端用官方 `@vercel/cron` 的 `verifyCronSignature` 校验。
- **② GitHub Actions 工作流**：`.github/workflows/reminder-cron.yml`（`0 * * * *`）每小时 curl 同一端点，带 `?secret=<CRON_SECRET>`。
- 两条链都只需每小时轮询；端点内部按「北京时间 hour == 页面配置的发送小时（默认 20:00）」二次放行，且对当日已发送任务做 `sent=1` 去重，因此**不会重复发送邮件**。
- ⚠️ 若只想让 Vercel 单独驱动，可禁用 GitHub Actions 工作流；二者并存时无需额外处理并发。

密钥获取：Supabase 控制台 → **Settings → API** → `Project URL` 与 `Project API keys`。

### 步骤 3：推送部署

push 到 `main` 即触发 `.github/workflows/deploy.yml`，自动构建并把上述变量
通过 `vercel deploy -e` 注入 Vercel 运行时。

### 步骤 4：验证

```bash
curl https://<你的域名>/api/health
```

期望输出（关键是 `driver: "supabase"` 且 `connected: true`）：

```json
{
  "ok": true,
  "driver": "supabase",
  "supabase": { "urlConfigured": true, "keyConfigured": true, "connected": true, "connectError": null },
  "sqlite": { "active": false }
}
```

## 四、表结构与初始账号

**无需手动建表**：应用首次启动（`ensureReady`）会自动创建 11 张表：

- `tasks` / `documents` / `email_config` / `email_recipients`
- `reminders` / `task_logs` / `task_progress`
- `users` / `settings` / `milestones` / `risks`

首次启动自动创建默认超管 **admin / admin123**（**请上线后立即修改密码**）。

## 五、排障：`/api/health` 对照表

健康检查接口**永不返回 500**，故障原因直接写在响应里。按 `connectError` 对照：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `urlConfigured: false` | 变量没注入到运行时 | 检查 GitHub 变量名拼写；确认 Actions 日志里「SUPABASE_URL 已配置」 |
| `keyConfigured: false` | 密钥缺失 | 补 `SUPABASE_SERVICE_ROLE_KEY` 或 `SUPABASE_ANON_KEY` |
| `Could not find the function ... exec_sql` | **步骤 1 没做**，或漏了 `NOTIFY pgrst` | 重新完整执行 `scripts/exec_sql.sql` |
| `Invalid API key` / `JWT` | 密钥与 URL 不属于同一项目，或已轮换 | 重新从 Settings → API 复制 |
| `driver: "sqlite"`, `engine: "asm"` | wasm 未打包，已回退纯 JS 引擎 | 服务可用但**数据不持久**，仍需修复 Supabase 连接 |
| `getaddrinfo ENOTFOUND db.*.supabase.co` | 仍在走已废弃的 5432 直连 | 删除 `SUPABASE_DB_URL` 变量，改用 `SUPABASE_URL` + 密钥 |
| `syntax error at or near "admin"` | 库里是**旧版 `exec_sql`**：按参数倒序全局替换占位符，遇到 bcrypt 哈希 `$2b$10$…` 时，替换 `$1` 会误伤哈希内 `$10$` 里的 `$1`，把语句撕碎 | 重新完整执行一次 `scripts/exec_sql.sql`（新版改为单趟扫描替换） |
| `sqlite.initError: no such table: users` | 旧版 `ensureSchema` 用单个布尔量记忆建表状态，Supabase 建表成功后再降级，SQLite 分支被跳过 | 已修复为按驱动分别记忆；升级代码即可 |
| `Supabase 上的 exec_sql 是【旧版有 bug 的实现】…` | 启动探针主动识别出库里部署的是旧版函数（见上一条） | 按提示重新完整执行 `scripts/exec_sql.sql`。**该函数存在于数据库中，重新部署代码不会更新它** |
| 能登录，但**任务数据一片空白** | 内置种子（`api/embedded-seed.js`）未导入 | 正常情况下首次初始化会自动导入 21 个任务等数据；若被跳过，检查是否设了 `FREEDOM_SKIP_SEED`，或 `settings` 表里已有 `seed_imported` 标记 |

前端 **设置 → 数据存储状态** 也会实时展示同样的信息。

## 五之二、内置种子数据

`api/embedded-seed.js` 是一份 base64 编码的 SQLite 快照，含项目初始业务数据
（21 个任务、21 份文档、12 个里程碑、10 项风险、2 个用户、1 份邮件配置）。

首次初始化时会**按行读出并经统一 `db.prepare` 接口写入**，因此对 Supabase 与 SQLite 两种驱动都生效。

- **幂等**：导入后在 `settings` 表写入 `seed_imported=1`，之后不再导入。
  判定只认这个标记，**不会**因为「表是空的」就重新灌入——否则用户主动清空数据后会被自动还原，属于数据事故。
- **已有数据的库**：若 `tasks` 非空（本功能上线前就建好的库），只补标记、不灌数据。
- **关闭**：置环境变量 `FREEDOM_SKIP_SEED=1` 可得到纯净空库（自动化测试即用此开关）。
- **导入时不带 `id`**，交给数据库自增。外键都走 `task_id`(TEXT) 而非数字 `id`，
  因此丢弃 `id` 既不破坏关联，又免去 Postgres `BIGSERIAL` 序列不同步、后续插入撞主键的问题。

## 六、本地开发

```bash
npm install

# 连 Supabase（可选；不配则自动用 SQLite 兜底，方便离线开发）
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="<service-role-key>"

npm run dev        # http://localhost:3000
```

不配置任何 Supabase 变量时服务照常启动，走 SQLite 兜底，适合纯前端联调。

## 七、测试

```bash
npm test
```

包含三套，全部离线运行、无需网络或真实 Supabase：

**1. `functional-test-supabase.js` — 132 项断言 / 17 个分组**

用 **[PGlite](https://pglite.dev)**（WASM 版真实 Postgres）通过 `Module._load` 钩子
模拟 `@supabase/supabase-js`，并启动**两个 server.js 实例**共享同一个库，
精确复现 Vercel「多实例 + 单一 Supabase」的真实拓扑。覆盖：

1. 11 张表自动初始化
2. 注册 / 登录 / JWT 鉴权
3. 存储状态接口
4. 任务 CRUD（含 `RETURNING id` 主键回填）
5. **核心回归：跨实例编辑不互相覆盖**
6. 进度 / 状态联动（进度 100% 自动置为已完成）
7. 文档 upsert（`INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`）
8. 提醒设置（`settings` 表无 `id` 列，验证不误加 `RETURNING id`）
9. 邮件配置 / 收件人
10. 用户管理（非超管不能删自己）
11. 仪表盘 / 报表聚合
12. 里程碑 / 风险 / 提醒（验证日期转型）
13. 定时任务（cron）
14. 级联删除
15. 错误处理中间件
16. 持久化真实性（写入对另一实例立即可见）
17. Excel 重置 / 增量导入

另含 **场景 C**：真实 `sql.js` 兜底路径的独立验证。

**2. `test-sqlite-nowasm.js` — 5 项**

模拟 Vercel 上 `.wasm` 未被打包的情形（`existsSync` 对 `.wasm` 返回 false），
验证自动回退 `sql-asm.js`、健康检查不 500、admin 仍可登录。

**3. `test-exec-sql-pglite.js` — 8 项**

用真 Postgres 验证 `exec_sql.sql` 函数本体：字面量替换、`INSERT...RETURNING`、
`rowCount`、NULL 处理，以及**防注入**（恶意输入被 `quote_literal` 当作纯字符串）。

## 八、安全说明

`exec_sql` 是 `SECURITY DEFINER` 函数，可执行任意 SQL。防护措施：

- `REVOKE ... FROM PUBLIC`，仅授权 `postgres` / `service_role` / `anon`。
- 固定 `SET search_path = public, pg_temp`，防止调用方改写 search_path 劫持。
- 参数一律经 `quote_literal` 转义为字面量，恶意输入无法破坏 SQL 结构（有测试覆盖）。
- **密钥仅服务端使用**：前端 `h5-app` 不引入 `@supabase/supabase-js`、不直连数据库，
  所有数据访问都经后端 API 网关，anon key 绝不下发浏览器。

> 若需更严格：把 `exec_sql.sql` 的 `GRANT` 收窄为仅 `service_role`，
> 并在部署变量中改用 `SUPABASE_SERVICE_ROLE_KEY`。

## 九、历史数据迁移（旧版 Blob + sql.js）

```bash
# 从本地 sqlite 文件导入
node scripts/migrate-to-supabase.js --sqlite ./freedom-db.sqlite
```

> 按 `task_id` / `username` 等自然键幂等 upsert，重复执行安全。
> 若无旧数据可跳过——首次启动即空库，超管自动创建，
> 任务数据可通过 **设置 → Excel 同步 / 导入 Excel** 载入。

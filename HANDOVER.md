# SillyTavern 多租户版 — 项目交接文档

> Fork：`github.com/joyiok/SillyTavern`（分支 `diy`）
> 上游：`github.com/SillyTavern/SillyTavern`（`release` 分支）
> 本文档更新至提交 `45d1116` 之后的迭代（2026-09）：新增**站点公告**、**用量统计**、**广场评论与收藏**

---

## 1. 项目概述

基于 SillyTavern 的**多租户化改造**，目标是对外运营一个多人使用的 AI 角色扮演/聊天站：

| 能力 | 状态 | 说明 |
|---|---|---|
| 多用户注册开通（邀请码 / 审批） | ✅ | 自助注册 + 单次邀请码 + 管理员审批 |
| 账号密码登录（不泄露用户名单） | ✅ | 私密登录模式默认开启 |
| 用户数据隔离 | ✅ | 原生 `data/<handle>/` 每用户独立目录 |
| 可选共享 + 作品广场 | ✅ | 发布/领取/点赞/举报/版本管理/审核 |
| 配额管理 | ✅ | 存储 / 角色卡数 / 广场作品数，超限拦截 |
| 托管模型 API | ✅ | 管理员配渠道，用户只能选用，Key 不出服务端 |
| 站点管理后台 | ✅ | 用户/用量/邀请码/渠道/公告/评论 统一管理页 |
| 站点公告 | ✅ | 管理员发布，登录后横幅提醒 + 公告页，按用户记录已读 |
| 用量统计 | ✅ | 每用户请求数/token/估算成本，日粒度 + 模型粒度 + 全站汇总 |
| 广场评论与收藏 | ✅ | 评论/点赞/隐藏/删除 + 我的收藏筛选，管理员全站评论审核 |
| 部署上线 | ⬜ | 方案见 §8，尚未实施 |

---

## 2. 功能详解

### 2.1 注册与登录
- 登录页（`/login`）：**用户名 + 密码**表单（`enableDiscreetLogin: true`，用户列表 API 返回 204 不暴露名单）+「注册」入口。
- 注册校验：用户名 3-24 位 `^[a-z0-9][a-z0-9_-]{2,23}$`、昵称 ≤40 字、密码最少 8 位（可配）。
- **邀请码**：管理页生成（单次/可重复、备注、复制）。只要存在任意邀请码（配置或动态），注册自动强制要码。
- **审批模式**（`registration.requireApproval`）：注册后账号为停用态，管理员在用户列表点「通过/启用」后方可登录。
- 防滥用：注册 5 次/小时/IP（`rateLimiting.accountsRegisterMaxAttempts`）。

### 2.2 作品广场（Gallery）
- 入口：主界面 ☰ 菜单 →「作品广场」→ **应用内浮层**（`gallery-embed.js`，不跳页）；`/gallery.html` 亦可直接访问，`/#gallery` 深链（`/#announcements`、`/#usage` 等可直接打开对应视图）。
- 浏览：搜索、标签、排序（最新/热门/下载榜/**讨论最多**/**我的收藏**/我的作品）。
- 发布向导：角色选择（可搜索）、标题/简介（计数）、标签 chips + 热门标签推荐、可见性（公开/仅自己可见）、版本说明、**实时预览**。
- 互动：一键领取（复制角色卡到自己目录）、点赞、**收藏**、**评论（发表/点赞/删除）**、举报（理由）、版本历史。
- 审核（管理员）：「管理视图」开关 → 统计栏（作品/领取/点赞/待处理举报）+ 筛选（全部/被举报/已隐藏/不公开）+ 隐藏/删除 + 举报明细；**站点管理 → 评论管理**可全站隐藏/删除评论。

### 2.2.1 评论（`gallery.allowComments`）
- 存储：`data/_gallery/comments/<itemId>.json`（与作品分离，删作品时一并清理）；作品记录里冗余 `commentCount` 供列表展示。
- 限制：单条最长 `gallery.commentMaxLength`（默认 1000，超长截断）、30 条/小时/用户、60 秒内重复内容拒绝。
- 权限：作者与管理员可删除；管理员可隐藏（隐藏后仅作者/管理员可见，计数不含隐藏）。
- 收藏：`data/<handle>/gallery-favorites.json`，纯个人数据，随账号删除而消失。

### 2.3 配额（`src/quotas.js`）
| 维度 | 配置键 | 默认 | 拦截点 |
|---|---|---|---|
| 存储空间 | `quotas.maxStorageMB` | 1024 | 角色创建/导入/复制、作品发布 |
| 角色卡数 | `quotas.maxCharacters` | 200 | 同上 |
| 广场作品数 | `quotas.maxGalleryItems` | 50 | 发布 |

- `-1` = 不限；超限返回 **413 + 中文提示**；管理页有每用户用量进度条。

### 2.4 托管模型渠道（`src/managed-channels.js`）— 安全核心
- 管理员配置渠道：名称 / 类型（`openai-compatible`、`anthropic`、`google`、`text-completions`）/ URL / API Key / 模型白名单 / **输入输出定价（每 1M tokens，可选，用于成本估算）** / 启用。
- **普通用户请求被服务端强制接管**（`managedChannelsMiddleware`）：
  - URL、Key、来源类型全部改写为托管渠道的值（Key 仅在内存注入，不落用户文件、不回传客户端）；
  - 用户自己填的接口地址/Key **一律忽略**；
  - 请求白名单外模型 → 403；
  - `/api/secrets` 写操作对非管理员 **403**（不能自存 Key）。
- 管理员不受限；**渠道列表为空时不拦截**（安全降级，不会锁死新装环境）。
- 覆盖端点：`/api/backends/chat-completions`、`/api/backends/text-completions`、`/api/backends/kobold`、`/api/openai`、`/api/google`、`/api/anthropic`、`/api/openrouter`。
- 用户在统一页面「模型」标签选渠道/模型（存 `data/<handle>/managed-channel.json`）；未选择时回退到第一个启用渠道。

### 2.5 统一管理界面
- 单一外壳：`/gallery.html` 五个视图 —— **广场 / 模型 / 公告 / 用量 / 站点管理**（后者仅管理员）。
- 全站跟随 ST 用户主题（动态同步 `--SmartTheme*` 变量）。
- `/admin.html` 自动跳转至 `/gallery.html`（历史兼容）。
- 另：ST 自带 Admin Panel（用户设置里）仍可用（创建/删除/备份/改密等）。

### 2.6 站点公告（`src/announcements.js`）
- 管理员在「公告」视图发布：标题 / 正文（多行）/ 级别（普通・通知・重要）/ 置顶 / 上架下架；可编辑、可删除（上限 200 条）。
- 用户侧：
  - 主界面右上角浮出**横幅**（`public/scripts/announcements.js`，每 5 分钟轮询），支持「知道了」「全部已读」「查看全部公告」；
  - ☰ 菜单新增「站点公告」入口，页签上有**未读徽标**；打开公告视图即自动标为已读。
- 已读状态按用户存于 `data/<handle>/announcements-read.json`（公告删除时自动清理）；普通用户的列表不返回作者信息。

### 2.7 用量统计（`src/usage.js`）
- **采集点**：`usageTrackingMiddleware` 挂在文本生成类端点之前（`chat-completions/generate`、`text-completions/generate`、`kobold/generate`、`novelai/generate`、`azure/generate`、`horde/generate-text`），**不统计** status/模型列表/绘图/语音等辅助接口。
- **token 解析**：包裹 `res.write/res.end` 只保留**尾部 256KB**，兼容非流式 JSON、OpenAI SSE（`usage`）、Anthropic（`input_tokens`/`output_tokens`）、Google（`usageMetadata`）；流式累计值取最大值。
- **成本**：按渠道 `priceInput`/`priceOutput`（每 1M tokens）估算；未配定价则为 0。
- **存储**：`data/<handle>/usage-stats.json`（随账号删除而消失）——`totals` + `days`（按日，默认保留 90 天）+ `models`（按模型，最多 50 个）。内存聚合，**每 10 秒落盘一次**，进程退出时强制 flush。
- **展示**：
  - 用户：「用量」视图 —— 今日/近 30 天/累计卡片（请求数、token、估算费用）+ 14 天柱状图 + 模型明细表。
  - 管理员：同页「全站用量」——活跃用户数、全站卡片/图表/模型表 + 用户排行；站点管理的用户列表每行额外显示「请求・token・费用・最近使用」。

---

## 3. 代码地图

### 3.1 新增文件
| 文件 | 职责 |
|---|---|
| `src/registration.js` | 邀请码存取/校验/单次消费、注册配置 |
| `src/quotas.js` | 配额计算与检查（目录大小/角色数/作品数） |
| `src/managed-channels.js` | 托管渠道 CRUD + 强制接管中间件 + 密钥写入拦截 |
| `src/announcements.js` | 公告 CRUD + 按用户已读状态 |
| `src/usage.js` | 用量采集中间件（token 解析）+ 聚合/汇总 + 成本估算 |
| `src/endpoints/gallery.js` | 广场 API（作品/互动/评论/收藏/审核） |
| `src/endpoints/admin.js` | 站点管理 API（用户+用量、邀请码、渠道、全站统计） |
| `src/endpoints/channels.js` | 用户侧渠道列表/选择 |
| `src/endpoints/announcements.js` | 公告 API（用户列表/已读 + 管理员 CRUD） |
| `src/endpoints/usage.js` | 用户自己的用量汇总 |
| `public/gallery.html` + `public/scripts/gallery.js` | 统一页面（广场/模型/公告/用量/管理） |
| `public/scripts/gallery-embed.js` | 主界面内浮层加载器（支持指定视图） |
| `public/scripts/announcements.js` | 主界面公告横幅 + 轮询 |
| `public/css/gallery.css` | 广场/管理/公告/用量/评论/横幅样式（ST 主题变量驱动） |

### 3.2 改动文件（合并上游时的冲突点）
| 文件 | 改动 |
|---|---|
| `src/endpoints/users-public.js` | `GET /registration-config`、`POST /register` |
| `src/endpoints/characters.js` | create/import/duplicate 加配额检查 |
| `src/endpoints/secrets.js` | `readSecret()` 加托管渠道内存覆盖（7 行） |
| `src/server-startup.js` | 挂载路由 + 中间件（含 `LLM_USAGE_PATHS` 用量采集） |
| `default/config.yaml` | 新增 registration / quotas / managedChannels / gallery / announcements / usageStats 段；默认开启多用户与私密登录 |
| `public/login.html` / `public/scripts/login.js` | 注册表单 |
| `public/index.html` | 广场与公告菜单项 + embed/announcements 脚本 + gallery.css |
| `public/css/login.css` | 注册表单布局 |
| `public/locales/zh-cn.json` | 「Gallery → 作品广场」「Announcements → 站点公告」 |

### 3.3 运行时数据布局（`data/`，勿提交）
```
data/
├── _gallery/items/         # 广场作品：<id>.png（角色卡快照）+ <id>.json（元数据）
├── _gallery/comments/      # 作品评论：<itemId>.json
├── _managed/channels.json  # 托管模型渠道（含 Key 与定价，注意权限！）
├── _registration/invites.json  # 动态邀请码
├── _announcements/announcements.json  # 站点公告
├── cookie-secret.txt
└── <handle>/               # 每用户独立目录（角色/聊天/设置/secrets）
    ├── managed-channel.json        # 该用户的渠道选择
    ├── usage-stats.json            # 用量统计（totals/days/models）
    ├── announcements-read.json     # 公告已读状态
    └── gallery-favorites.json      # 收藏的作品 ID
```

> 用量/公告已读/收藏均存在用户自己目录下，删除账号时自动清理，不会遗留孤立数据。

---

## 4. 配置参考（`config.yaml` 新增段）

```yaml
enableUserAccounts: true        # 多用户模式（fork 默认开）
enableDiscreetLogin: true       # 用户名密码登录、不暴露用户列表（fork 默认开）

registration:
  enabled: true                 # 开放注册
  inviteCodes: []               # 静态邀请码（可多个，永久有效）
  requireInvite: false          # 强制邀请码（存在任意邀请码时自动强制）
  requireApproval: false        # 注册需管理员审批
  minPasswordLength: 8

quotas:
  enabled: true
  maxStorageMB: 1024            # -1 = 不限
  maxCharacters: 200
  maxGalleryItems: 50

managedChannels:
  enabled: true
  restrictNonAdmins: true       # 非管理员强制走托管渠道

gallery:
  enabled: true
  allowPublish: true
  allowComments: true           # 作品评论
  commentMaxLength: 1000        # 单条评论最长字数
  requireApproval: false        # true = 新作品先隐藏待审
  pageSize: 24

announcements:
  enabled: true                 # 站点公告

usageStats:
  enabled: true                 # 用量统计（请求数/token/成本）
  retentionDays: 90             # 保留多少天的日粒度明细
  currency: "¥"                 # 成本显示的货币符号
```

渠道定价不在 config.yaml，而在管理页的渠道表单里（`priceInput`/`priceOutput`，单位：元 / 1M tokens，留空 = 不计价）。

改配置后**重启生效**。密钥类文件（`data/_managed/channels.json`、`data/<handle>/secrets.json`）建议 `chmod 600`。

---

## 5. 管理员手册

1. **首个管理员**：`data/default-user`（无密码，仅限本机/初装时使用，尽快改密）。
2. **用户**：站点管理 → 用户列表 → 通过/启用、停用、设为管理员、删除；右侧为存储/角色/作品配额进度条，下方为 LLM 用量（请求・token・费用・最近使用）。
3. **邀请码**：站点管理 → 生成（单次使用推荐）→ 复制发给用户；用后自动标记。
4. **模型渠道**：「模型」标签 → 管理模型渠道 → 填名称/类型/URL/Key/模型列表/**输入输出定价** → 保存。换供应商只改渠道，全站即时生效。
5. **站点公告**：「公告」标签 → 填标题/级别/正文 → 可选置顶 → 发布；已发公告可编辑或删除。用户登录后会看到横幅提醒。
6. **用量审阅**：「用量」标签（管理员额外看到全站区块）：活跃用户数、全站 token/费用、按模型明细、用户排行；可据此做成本分摊或调整配额。
7. **内容审核**：广场 → 管理视图 → 待处理举报 → 隐藏/删除；站点管理 → 评论管理 → 隐藏/删除评论。
8. **备份**：定期打包 `data/`（重点：`_managed`、`_registration`、`_announcements`、`_gallery`、各用户目录）。ST 自带每用户备份下载（用户设置 → Account → Backup）。

---

## 6. 新增 API 速查

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/users/registration-config` | 公开 | 注册开关/是否需邀请码/密码策略 |
| POST | `/api/users/register` | 公开(限速) | 注册 `{handle,name,password,inviteCode}` |
| POST | `/api/gallery/list|item|publish|update|delete|like|claim|report|tags` | 登录 | 广场 |
| POST | `/api/gallery/comments|comment|comment/delete|comment/like` | 登录 | 作品评论 |
| POST | `/api/gallery/favorite` | 登录 | 收藏/取消收藏 |
| GET | `/api/gallery/image/:id` | 登录 | 作品封面 |
| POST | `/api/gallery/admin/list|hide|delete|comments` | 管理员 | 内容审核（含全站评论） |
| POST | `/api/gallery/comment/hide` | 管理员 | 隐藏/显示评论 |
| POST | `/api/admin/users` | 管理员 | 用户列表 + 配额用量 + LLM 用量 + 全站汇总 |
| POST | `/api/admin/usage` | 管理员 | 全站用量（日序列/模型/用户排行） |
| POST | `/api/admin/registration` | 管理员 | 注册设置 + 邀请码列表 |
| POST | `/api/admin/invites/create|delete` | 管理员 | 邀请码 |
| POST | `/api/admin/channels/list|save|delete` | 管理员 | 托管渠道（含定价） |
| POST | `/api/channels/list|select` | 登录 | 渠道选择（无 Key） |
| POST | `/api/announcements/list|read` | 登录 | 公告列表（含已读态）/标记已读 |
| POST | `/api/announcements/admin/list|save|delete` | 管理员 | 公告 CRUD |
| POST | `/api/usage/me` | 登录 | 自己的用量汇总 |

---

## 7. 测试记录

### 7.1 可重复的冒烟脚本（推荐）
```bash
npm start                     # 终端 1：启动服务器
node tests/diy-smoke.mjs      # 终端 2：跑冒烟测试
```
- 自带 mock LLM（随机端口），自建临时渠道/公告/用户/作品，结束后**自动清理全部测试数据**，可重复运行。
- 环境变量：`ST_BASE_URL`、`ST_ADMIN_HANDLE`（默认 `default-user`）、`ST_ADMIN_PASSWORD`。
- 注意：受平台限速影响（注册 5 次/小时/IP、登录 5 次/5 分钟/IP），一小时内反复跑需重启服务重置计数器；**不要在生产站点上跑**。
- 当前结果：**66/66 通过**，覆盖：
  - 注册与审批：开放注册 ✓ / 审批前登录 403 ✓ / 通过后登录 ✓ / 重名 409 ✓
  - 公告：发布/更新/空标题 400 ✓ / 置顶排序 ✓ / 单条与全部已读 ✓ / **已读按用户隔离** ✓ / 非管理员访问管理接口 403 ✓ / 用户侧不返回作者 ✓
  - 广场：建卡→发布→搜索→领取（downloads+1）✓ / 点赞与取消 ✓ / 举报+防重复 ✓ / 管理员隐藏后不可见但作者可见 ✓
  - 收藏：添加 ✓ / `favorites` 筛选 ✓ / 取消 ✓
  - 评论：发表 ✓ / 空内容 400 ✓ / 60 秒重复 409 ✓ / 超长截断 1000 ✓ / 点赞 ✓ / 管理员隐藏（计数同步、仅作者与管理员可见）✓ / 评论作者自删 ✓ / 作品作者可管理自己作品下的评论 ✓ / 全站评论列表仅管理员 ✓
  - 托管渠道：渠道定价保存 ✓ / **Key 不外泄**（只回 keyHint）✓ / 用户自带 `reverse_proxy` 被强制改写 ✓ / 白名单外模型 403 ✓ / 选择白名单外模型 400 ✓ / `secrets` 写入 403 ✓
  - 用量：非流式+流式 token 解析（330/92）✓ / 按渠道定价估算成本 ✓ / 按模型分组带渠道名 ✓ / 14 天序列 ✓ / **status 等辅助接口不计入** ✓ / 失败请求计入 errors ✓ / 按用户隔离 ✓ / 全站汇总与用户排行 ✓ / 管理页用户列表含 token・成本・最近使用 ✓

### 7.2 前端 DOM 验证（临时，jsdom）
用 jsdom 加载 `public/gallery.html` + 打桩 `fetch` 执行 `public/scripts/gallery.js`，**32/32 通过**：广场卡片（评论数/收藏徽标）、公告视图（级别样式/换行/管理列表/未读清零）、用量视图（9 张卡片/14 柱图表/模型表/全站排行）、站点管理（用户行/配额条/邀请码/评论审核）、模型渠道（定价展示）、详情弹窗（评论列表/隐藏标记/倒序/点赞数/Ctrl+Enter 发表）。
主界面公告横幅 `public/scripts/announcements.js` 单独验证 **7/7 通过**（自动弹出/级别样式/未读计数/知道了逐条/全部已读关闭）。
> jsdom 不是项目依赖，这两个脚本未入库（`npm i --no-save jsdom` 后可复现）；入库的是 §7.1 的后端冒烟脚本。

### 7.3 历史人工测试（上一轮，仍有效）
- 平台限速：注册 5 次/小时/IP 触发 ✓
- 配额：超限 413 + 中文提示 ✓；用量统计 ✓
- 登录：用户名密码 ✓ / 用户列表 204 不暴露 ✓
- Lint：`npx eslint src/ public/scripts/` 全绿；HTML 标签配对校验通过；gallery.html 中 94 个被 JS 引用的 id 均存在，与 index.html **无 id 冲突**（浮层模式下安全）

冒烟命令：
```bash
npm install && npm start     # http://127.0.0.1:8000
npx eslint src/ public/scripts/
node tests/diy-smoke.mjs     # 66 项回归（需服务器已启动）
```

---

## 8. 部署方案（待实施）

目标机：`212.47.76.135`（4C/8G/100G，Debian 13，已配 SSH 密钥）。

建议：
1. **运行**：Docker Compose（官方 `Dockerfile`）或 systemd + Node 22。
2. **反代 + HTTPS**：Caddy（自动证书）或 nginx + certbot。需要一个域名解析到该 IP（**待确认是否有域名**）。
3. **数据**：`data/` 挂载为持久卷；每日 cron 打包备份（保留 7 天），可选异地。
4. **安全**：`chmod 600 data/_managed/channels.json`；防火墙只开 80/443；`default-user` 设置强密码；开启 `registration.requireApproval` 防滥用。
5. **升级**：`git fetch upstream && git merge upstream/release`（冲突点见 §3.2）→ `npm install` → 重启。

---

## 9. 已知限制 / 注意事项

- 托管渠道目前通过改写 `reverse_proxy`/`custom_url` 字段接管；上游新增的后端类型需要在 `server-startup.js` 的中间件挂载处补一行。
- `channel key` 明文存于 `data/_managed/channels.json`（与 ST 原生 secrets 同等安全级别）。
- 模型白名单只在渠道配置了模型列表时生效；留空 = 不限制模型。
- 用户在 ST 原生「API 连接」面板中的设置会被服务端改写（界面所选与实际线路可能不一致，属预期行为；面板未来可隐藏）。
- **用量统计**：只统计 §2.7 列出的文本生成类端点（绘图/TTS/嵌入/翻译不计）；成本为**估算值**，依赖管理员在渠道里填写定价，未填则显示 ¥0；token 来自上游返回的 usage 字段，若供应商不返回则只计请求数。计数在内存聚合，进程异常退出最多丢 10 秒数据。
- **评论**：单层结构（无回复/楼中楼）、不支持编辑；每作品最多保留 1000 条（超出丢弃最早的）；限速 30 条/小时/用户。
- **公告**：纯文本 + 换行（无富文本/Markdown），不支持定时发布与自动过期；上限 200 条；已读状态按用户存盘（换浏览器不影响）。
- **删除用户**：上游 `/api/users/delete` 不带 `purge` 时只删账号记录，`data/<handle>/` 会保留（管理页删除按钮目前也不传 purge）；用量/收藏/公告已读均在该目录内，因此 `purge: true` 时会一并清理。
- 全站活跃度趋势仅保留 `usageStats.retentionDays`（默认 90 天）的日粒度数据，更早的明细会被自动修剪（累计值保留）。

## 10. 待办路线图

已完成（本轮）：
- [x] 站点公告（发布/置顶/级别/横幅提醒/按用户已读）
- [x] 用量深度统计（token、请求数、成本估算、按日/按模型/全站汇总）
- [x] 作品广场：评论（点赞/隐藏/删除/全站审核）+ 收藏夹
- [x] 可重复的回归冒烟脚本 `tests/diy-smoke.mjs`

待办：
1. **部署上线**（§8）+ 域名/HTTPS（当前最大缺口）
2. 新手引导 / 帮助中心（可复用公告机制做首次登录引导）
3. 用量配额化：按月 token/成本上限，超限降速或拦截（现在只有存储/角色/作品配额）
4. 广场：分类页、评论回复（楼中楼）、搜索排序扩展
5. 隐藏 ST 原生「API 连接」面板（普通用户）以免界面与实际线路不一致
6. 上游同步流程固化（脚本化 rebase + 冲突清单，见 §3.2）

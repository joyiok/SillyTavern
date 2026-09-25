# SillyTavern 多租户版 — 项目交接文档

> Fork：`github.com/joyiok/SillyTavern`（分支 `diy`）
> 上游：`github.com/SillyTavern/SillyTavern`（`release` 分支）
> 本文档更新至提交 `6f428cf`（2026-09）

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
| 站点管理后台 | ✅ | 用户/用量/邀请码/渠道 统一管理页 |
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
- 入口：主界面 ☰ 菜单 →「作品广场」→ **应用内浮层**（`gallery-embed.js`，不跳页）；`/gallery.html` 亦可直接访问，`/#gallery` 深链。
- 浏览：搜索、标签、排序（最新/热门/下载榜/我的作品）。
- 发布向导：角色选择（可搜索）、标题/简介（计数）、标签 chips + 热门标签推荐、可见性（公开/仅自己可见）、版本说明、**实时预览**。
- 互动：一键领取（复制角色卡到自己目录）、点赞、举报（理由）、版本历史。
- 审核（管理员）：「管理视图」开关 → 统计栏（作品/领取/点赞/待处理举报）+ 筛选（全部/被举报/已隐藏/不公开）+ 隐藏/删除 + 举报明细。

### 2.3 配额（`src/quotas.js`）
| 维度 | 配置键 | 默认 | 拦截点 |
|---|---|---|---|
| 存储空间 | `quotas.maxStorageMB` | 1024 | 角色创建/导入/复制、作品发布 |
| 角色卡数 | `quotas.maxCharacters` | 200 | 同上 |
| 广场作品数 | `quotas.maxGalleryItems` | 50 | 发布 |

- `-1` = 不限；超限返回 **413 + 中文提示**；管理页有每用户用量进度条。

### 2.4 托管模型渠道（`src/managed-channels.js`）— 安全核心
- 管理员配置渠道：名称 / 类型（`openai-compatible`、`anthropic`、`google`、`text-completions`）/ URL / API Key / 模型白名单 / 启用。
- **普通用户请求被服务端强制接管**（`managedChannelsMiddleware`）：
  - URL、Key、来源类型全部改写为托管渠道的值（Key 仅在内存注入，不落用户文件、不回传客户端）；
  - 用户自己填的接口地址/Key **一律忽略**；
  - 请求白名单外模型 → 403；
  - `/api/secrets` 写操作对非管理员 **403**（不能自存 Key）。
- 管理员不受限；**渠道列表为空时不拦截**（安全降级，不会锁死新装环境）。
- 覆盖端点：`/api/backends/chat-completions`、`/api/backends/text-completions`、`/api/backends/kobold`、`/api/openai`、`/api/google`、`/api/anthropic`、`/api/openrouter`。
- 用户在统一页面「模型」标签选渠道/模型（存 `data/<handle>/managed-channel.json`）；未选择时回退到第一个启用渠道。

### 2.5 统一管理界面
- 单一外壳：`/gallery.html` 三个视图 —— **广场 / 模型 / 站点管理**（后者仅管理员）。
- 全站跟随 ST 用户主题（动态同步 `--SmartTheme*` 变量）。
- `/admin.html` 自动跳转至 `/gallery.html`（历史兼容）。
- 另：ST 自带 Admin Panel（用户设置里）仍可用（创建/删除/备份/改密等）。

---

## 3. 代码地图

### 3.1 新增文件
| 文件 | 职责 |
|---|---|
| `src/registration.js` | 邀请码存取/校验/单次消费、注册配置 |
| `src/quotas.js` | 配额计算与检查（目录大小/角色数/作品数） |
| `src/managed-channels.js` | 托管渠道 CRUD + 强制接管中间件 + 密钥写入拦截 |
| `src/endpoints/gallery.js` | 广场 API（14 个端点） |
| `src/endpoints/admin.js` | 站点管理 API（用户+用量、邀请码、渠道） |
| `src/endpoints/channels.js` | 用户侧渠道列表/选择 |
| `public/gallery.html` + `public/scripts/gallery.js` | 统一页面（广场/模型/管理） |
| `public/scripts/gallery-embed.js` | 主界面内浮层加载器 |
| `public/css/gallery.css` | 广场/管理/浮层样式（ST 主题变量驱动） |

### 3.2 改动文件（合并上游时的冲突点）
| 文件 | 改动 |
|---|---|
| `src/endpoints/users-public.js` | `GET /registration-config`、`POST /register` |
| `src/endpoints/characters.js` | create/import/duplicate 加配额检查 |
| `src/endpoints/secrets.js` | `readSecret()` 加托管渠道内存覆盖（7 行） |
| `src/server-startup.js` | 挂载路由 + 中间件 |
| `default/config.yaml` | 新增 registration / quotas / managedChannels / gallery 段；默认开启多用户与私密登录 |
| `public/login.html` / `public/scripts/login.js` | 注册表单 |
| `public/index.html` | 广场菜单项 + embed 脚本 + gallery.css |
| `public/css/login.css` | 注册表单布局 |
| `public/locales/zh-cn.json` | 「Gallery → 作品广场」 |

### 3.3 运行时数据布局（`data/`，勿提交）
```
data/
├── _gallery/items/         # 广场作品：<id>.png（角色卡快照）+ <id>.json（元数据）
├── _managed/channels.json  # 托管模型渠道（含 Key，注意权限！）
├── _registration/invites.json  # 动态邀请码
├── cookie-secret.txt
└── <handle>/               # 每用户独立目录（角色/聊天/设置/secrets）
    └── managed-channel.json    # 该用户的渠道选择
```

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
  requireApproval: false        # true = 新作品先隐藏待审
  pageSize: 24
```

改配置后**重启生效**。密钥类文件（`data/_managed/channels.json`、`data/<handle>/secrets.json`）建议 `chmod 600`。

---

## 5. 管理员手册

1. **首个管理员**：`data/default-user`（无密码，仅限本机/初装时使用，尽快改密）。
2. **用户**：站点管理 → 用户列表 → 通过/启用、停用、设为管理员、删除；右侧为用量进度条。
3. **邀请码**：站点管理 → 生成（单次使用推荐）→ 复制发给用户；用后自动标记。
4. **模型渠道**：「模型」标签 → 管理模型渠道 → 填名称/类型/URL/Key/模型列表 → 保存。换供应商只改渠道，全站即时生效。
5. **内容审核**：广场 → 管理视图 → 待处理举报 → 隐藏/删除。
6. **备份**：定期打包 `data/`（重点：`_managed`、`_registration`、各用户目录）。ST 自带每用户备份下载（用户设置 → Account → Backup）。

---

## 6. 新增 API 速查

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/api/users/registration-config` | 公开 | 注册开关/是否需邀请码/密码策略 |
| POST | `/api/users/register` | 公开(限速) | 注册 `{handle,name,password,inviteCode}` |
| POST | `/api/gallery/list|item|publish|update|delete|like|claim|report|tags` | 登录 | 广场 |
| GET | `/api/gallery/image/:id` | 登录 | 作品封面 |
| POST | `/api/gallery/admin/list|hide|delete` | 管理员 | 内容审核 |
| POST | `/api/admin/users` | 管理员 | 用户列表 + 用量 + 配额 |
| POST | `/api/admin/registration` | 管理员 | 注册设置 + 邀请码列表 |
| POST | `/api/admin/invites/create|delete` | 管理员 | 邀请码 |
| POST | `/api/admin/channels/list|save|delete` | 管理员 | 托管渠道 |
| POST | `/api/channels/list|select` | 登录 | 渠道选择（无 Key） |

---

## 7. 测试记录（均已在本地 127.0.0.1:8000 实测通过）

- 注册：开放注册 ✓ / 重名 409 ✓ / 弱密码 400 ✓ / 邀请码必须 ✓ / 单次码防重复 ✓ / 审批拦截→通过→登录 ✓
- 平台限速：注册 5 次/小时/IP 触发 ✓
- 广场：发布 ✓ / 跨用户领取（文件复制）✓ / 点赞 ✓ / 举报+防重复 ✓ / 管理员隐藏后不可见 ✓ / 更新版本 ✓
- 配额：超限 413 + 中文提示 ✓；用量统计 ✓
- 托管渠道：**用户野接口/自填 Key 被强制改写到托管渠道并携带管理员 Key** ✓ / 白名单外模型 403 ✓ / secrets 写 403 ✓ / Key 脱敏 ✓
- 登录：用户名密码 ✓ / 用户列表 204 不暴露 ✓
- Lint：`npx eslint src/ public/scripts/` 全绿；HTML 结构校验通过

冒烟命令：
```bash
npm install && npm start     # http://127.0.0.1:8000
npx eslint src/ public/scripts/
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
- 站点统计（活跃度/成本）尚无，后续可在 `/api/admin/users` 基础上扩展。

## 10. 待办路线图

1. 部署上线（§8）+ 域名/HTTPS
2. 站点公告 / 新手引导
3. 用户用量深度统计（token 用量、成本分摊）
4. 作品广场：评论、收藏夹、分类页
5. 上游同步流程固化（脚本化 rebase + 冲突清单）

# NOVA 部署、备份与恢复手册

- 适用范围：V0.1 / V0.2 单实例部署
- 基线：`main`
- 相关安全项：SEC-05（CSP）、SEC-08（CSRF/Origin）、SEC-09（Session 清理）、SEC-10（管理员审计）、SEC-11（部署检查）

## 1. 部署形态

NOVA 采用单进程部署：Express API 同时提供 `/api/v1` 与生产前端构建产物。

1. `npm ci`
2. `npm run build`（生成 `client/dist`）
3. `NODE_ENV=production npm start`

当 `client/dist/index.html` 存在时，API 进程会托管静态资源，并把非 `/api` 的 GET 请求回退到 `index.html`，因此 `/documents/12` 这类客户端路由可以直接刷新。开发环境仍可用 `npm run dev`（Vite 5173 + API 4000）。

## 2. 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `SESSION_SECRET` | 是 | ≥ 32 字符随机值；泄露等同于会话伪造 |
| `PROVIDER_ENCRYPTION_KEY` | 管理 Provider 时必需 | ≥ 32 字符；用于 AES-256-GCM。丢失后数据库中的 Provider 密钥无法解密 |
| `DB_PATH` | 否 | 默认 `server/data/nova.sqlite`；生产必须放在持久卷 |
| `WEB_ORIGIN` | 是 | 允许的前端来源，逗号分隔；生产必须是 HTTPS 正式域名 |
| `AI_PROVIDERS_JSON` / `AI_BASE_URL` 等 | 否 | 环境 Provider，优先于数据库托管 Provider 且只读 |
| `RESEARCH_SEARCH_PROVIDER` + `RESEARCH_SEARCH_URL` 或 `BRAVE_SEARCH_API_KEY` | 否 | 未配置时 Research 搜索返回 `RESEARCH_SEARCH_NOT_CONFIGURED`，不会伪造结果 |
| `BACKUP_DIR` / `BACKUP_KEEP` | 否 | 备份目录与保留份数，默认 `backups/`、7 份 |

生产环境启动时会强制校验：`NODE_ENV=production` 下 Provider 基础地址必须是 HTTPS；变更请求必须携带受信任 `Origin`。

## 3. 反向代理与 HTTPS

- 终止 TLS 的代理（Nginx / Caddy / Cloudflare Tunnel）负责 HTTPS；应用只监听内网端口。
- 当前限流按进程内存与用户 ID 计数，未启用 IP 维度限流。启用 IP 限流前必须先配置 `app.set('trust proxy', …)` 并确认可信代理跳数，否则所有访问者会被计为同一来源。
- Cookie 为 `HttpOnly`、`SameSite=Strict`、`Path=/api`，生产自动 `Secure`；前后端必须同站部署，跨站部署会使会话失效。

## 4. 安全响应头

- API 响应统一由 Helmet 下发 `default-src 'none'` 的 CSP，并附带 `X-Request-Id`。
- 前端 `index.html` 由应用下发文档级 CSP：`default-src 'self'`、`frame-ancestors 'none'`、`object-src 'none'`、`script-src 'self'`、字体仅允许 `fonts.googleapis.com` / `fonts.gstatic.com`、`connect-src` 含配置的 `WEB_ORIGIN`。
- 若改用外部静态托管前端，必须在该托管上复制同一份 CSP，否则浏览器会按托管策略执行（通常是"无 CSP"）。

## 5. 备份

```bash
npm run db:backup            # 生成 backups/nova-<timestamp>.sqlite + .json 清单
BACKUP_KEEP=14 npm run db:backup
BACKUP_DIR=/mnt/volume/backups npm run db:backup
```

备份使用 SQLite 在线备份 API，包含 WAL 中的已提交数据；生成后立即执行 `PRAGMA integrity_check`，失败会删除产物并非零退出。清单记录 sha256、字节数、表数量与 schema 版本。

建议：每日一次备份 + 每次升级前手动备份，并把备份同步到与数据库不同的物理位置。

## 6. 恢复演练

```bash
npm run db:verify -- backups/nova-2026-11-07T14-05-01-969Z.sqlite
# 停止 API 进程后再执行恢复
npm run db:restore -- backups/nova-2026-11-07T14-05-01-969Z.sqlite
npm run db:verify
```

恢复前会校验备份完整性，并把现有数据库重命名为 `nova.sqlite.pre-restore-<timestamp>`（保留回滚点），随后清理 `-wal`/`-shm` 再复制备份文件。恢复后再次校验，失败即报错。

演练记录：2026-11-07 在本机完成一次"备份 → 校验 → 恢复到运行库 → 用户数据仍可读取"的完整回路，见 `docs/audits/B4-01-VERIFICATION.md`。

## 7. 运维检查

| 项目 | 位置 | 说明 |
|---|---|---|
| 管理员审计 | `GET /api/v1/admin/audit-logs` 或 Admin → 审计日志 | 角色变更、Provider/默认模型变更、Research 内容变更；不含密钥、密文、基础地址和正文 |
| 错误监控 | `GET /api/v1/admin/monitoring` 或 Admin → 错误监控 | 按稳定错误码聚合，含状态码、路由、请求 ID；进程重启清零 |
| 请求追踪 | 响应头 `X-Request-Id` | 与错误响应体中的 `requestId` 一致，便于对日志 |
| 会话清理 | 启动时 + 每 6 小时 | 删除 `expires_at` 过期的 sessions 行 |

## 8. 上线前仍必须完成

1. 真实第三方模型的提示词/文件处理告知（SEC-07）。
2. 独立安全测试与完整 Git 历史密钥扫描。
3. 多实例部署前的共享限流/并发存储（当前为进程内存）。
4. Android 真机（含 Mate 20 Pro）上的登录、聊天、自动保存、文件上传与下载验收。
5. 生产日志告警接入（当前错误监控只在进程内聚合）。

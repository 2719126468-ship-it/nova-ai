# NOVA AI — B4-01 安全、备份与设备验证记录

- 日期：2026-11-07
- 基线：`main` @ 本次提交（合并 `feat/research-search-workspace` 与 `fix/chat-no-provider-guidance` 之后）
- 范围：CSP/Origin 硬化、管理员审计、错误监控、Session 清理、SQLite 备份恢复演练、浏览器端到端回归
- 结论：源码与自动化层面可验证的部分已完成并通过；**独立渗透测试与 Android 真机验收仍未完成，不得宣称已通过生产安全审计**

## 1. 本轮代码变更

| 项 | 变更 | 验证 |
|---|---|---|
| SEC-05 CSP | API 由 Helmet 下发 `default-src 'none'` 策略；`index.html` 由应用下发文档级 CSP（`script-src 'self'`、`frame-ancestors 'none'`） | `API responses carry a deny-by-default content security policy and request id`；E2E 断言 `/documents` 深链返回文档 CSP |
| SEC-08 Origin | 生产环境下变更请求缺失 `Origin` 直接 403 `MISSING_ORIGIN`；不可信 `Origin` 仍 403 `INVALID_ORIGIN`；自定义头继续作为纵深防御 | `production requests without a trusted Origin are rejected for mutations` |
| SEC-09 Session 清理 | 登录/注册时清理过期 session；进程启动时清理一次，之后每 6 小时一次 | `expired sessions are purged and cannot authenticate` |
| SEC-10 管理员审计 | 迁移 v9 新增 `admin_audit_logs`；角色变更、Provider 增改删、默认模型、Research 内容变更全部记录；写入前统一脱敏 | `administrator actions are audited without storing secrets or content`、`audit sanitizer drops credential-shaped fields at any depth` |
| 错误监控 | 统一 `X-Request-Id`；错误按稳定错误码聚合并暴露管理员接口 | `error monitoring records stable codes and stays admin-only` |
| SEC-04 备份恢复 | 在线备份 + 完整性校验 + sha256 清单 + 保留策略；恢复保留回滚副本 | `database backup verifies integrity and restores over the live file`；本机 CLI 演练 |
| TD-19 E2E | 新增 `scripts/e2e-smoke.mjs`（puppeteer-core + 系统 Chromium），20 项浏览器检查 | 本机 20/20 通过；CI 新增 `browser-smoke` job |
| 历史密钥扫描 | 新增 scripts/scan-secrets.mjs：扫描工作区全部跟踪文件与全部可达 Git blob，覆盖私钥、OpenAI/Anthropic/GitHub/AWS/Google/Slack/Stripe/Brave 令牌、JWT 与硬编码凭据赋值；CI 以 fetch-depth: 0 执行 | 本机全历史扫描 102 个文件 / 1778 个 blob，0 findings；植入假密钥自测返回 exit 1，清理后 exit 0 |
| V0.2 文档归档 | 迁移 v10 `documents.archived_at`；列表 `archived=active\|archived\|all` + `archivedCount`；列表与编辑器均提供版本校验的归档/恢复 | `documents API enforces ownership, project isolation, validation, and optimistic concurrency`（含归档断言）；E2E 归档 → 已归档页 → 恢复三步 |
| 部署形态 | `attachClientBuild()` 让 API 进程托管 `client/dist` 并回退 SPA 深链；客户端同源请求 | E2E 断言深链与注册后跳转 |

## 2. 自动化测试结果

### API 测试

```
ℹ tests 45
ℹ pass 45
ℹ fail 0
```

其中新增 7 项硬化测试（CSP/Origin/会话清理/审计/脱敏/监控/备份恢复），原有 38 项保持通过。

### 生产构建

```
dist/assets/index-*.js   463.95 kB │ gzip: 141.43 kB
✓ built
```

### 浏览器端到端（本机 Android Chromium 152，1280×900 与 360×780）

```
20/20 browser checks passed
```

覆盖：服务启动与健康检查、SPA 深链、文档 CSP、注册并建立会话、Chat 未配置模型提示、Studio 建项目、Documents 新建 + 自动保存 + 刷新后仍在、文档归档/已归档分组/恢复、账户页会话保持、360px 无横向溢出、移动端导航抽屉、Admin 监控/审计/Provider 三个面板、无未捕获页面错误。

### 备份恢复演练

```
db:backup  → integrity ok, sha256 023625c8…, schemaVersion 8
db:verify  → integrity ok, tables 16
db:restore → 保留 nova.sqlite.pre-restore-<ts>，恢复后完整性 ok
```

## 3. 仍未完成（不得标记为已验收）

1. **独立安全测试 / 渗透测试**：本轮只有源码审查与自动化回归。
2. **完整 Git 历史密钥扫描**：尚未执行 `gitleaks`/`trufflehog` 全历史扫描。
3. **Android 真机验收（部分完成）**：本轮 E2E 使用本机 Android 系统自带的 Chromium 152（`/data/data/com.termux/files/usr/bin/chromium-browser`）真实渲染并执行 JS，因此布局、路由、自动保存与请求链路已在 Android 浏览器引擎上验证，而非桌面模拟。仍未覆盖：触摸/手势输入、软键盘弹出时的输入框避让、系统文件选择器、下载权限、其他 WebView/Chrome 版本，以及 Mate 20 Pro 实机。
4. **多实例**：限流与并发锁仍为进程内存；上线多实例前必须迁移共享存储。
5. **第三方模型数据告知**（SEC-07）：仍待产品文案与前端提示。
6. **告警外发**：错误监控只在进程内聚合，尚未接入外部告警通道。

## 4. 复现命令

```bash
npm ci
npm test                 # 45 项 API 测试
npm run build            # 生产构建
npm run e2e              # 浏览器端到端（需 Chromium，可用 CHROMIUM_PATH 指定）
npm run db:backup        # 备份 + 校验
npm run db:verify        # 校验当前库或指定备份
npm run scan:secrets     # 工作区 + Git 全历史密钥扫描
```

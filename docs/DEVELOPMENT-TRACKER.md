# NOVA AI Development Tracker

- Updated: 2026-11-07
- Product stage: V0.1 core quality work → V0.2 AI Workspace → V0.3 Research
- Repository baseline: `main`
- Package version: keep `0.1.0` until release acceptance; do not bump for planning milestones.

## Progress

**11 / 12 complete** · 1 in progress · 0 planned

The existing V0.1 implementation is the foundation. Do not rebuild or replace working authentication, chat, SSE, model routing, Studio, account, or data-lifecycle flows. Extend them incrementally.

## Batch 1 — V0.1 core finish

| ID | Priority | Task | Status | Completion criteria |
|---|---|---|---|---|
| B1-01 | P0 | Review PR #4 against current main and selectively integrate valid changes | **Complete** | Old PR was not merged directly. The non-streaming disconnect cancellation was ported to current main in PR #5; regression test and CI passed. Existing 6/min per-user limiter and single-generation guard were retained. |
| B1-02 | P0 | Review and consolidate Provider error handling | **Complete** | Stable NOVA codes cover upstream authentication/permission, rejected requests, rate limits, outages, network failure, timeout, malformed JSON/SSE, empty response, stream errors, and cancellation; raw upstream details are redacted and regression-tested. |
| B1-03 | P0 | Design and implement persistent Usage records | **Complete** | Migration v3 persists request lifecycle, provider/model, duration, error code, and upstream-reported tokens across JSON, SSE, edit, and retry paths. Export/deletion and admin-only aggregates are covered; unknown token/cost values remain null. |
| B1-04 | P1 | Add code syntax highlighting and code-block copy | **Complete** | Common JS/TS, Python, JSON, Bash, CSS, XML/HTML, SQL, YAML, Markdown, Java, Go, and Diff grammars are registered selectively; per-block copy preserves only code text. Highlighter loads only for fenced-code messages and the mobile layout uses horizontal scrolling. |
| B1-05 | P1 | Add assistant answer version history and undo | **Complete** | Migration v4 stores prior assistant answers; successful edit/regeneration and retry preserve versions; failed/cancelled replacements leave prior content untouched; owner-scoped list/restore swaps preserve both answers; export/deletion and cross-account tests pass. |

### Batch 1 implementation notes

- Keep the current main-branch per-user generation limiter at 6 requests/minute and its single active-generation guard unless measured evidence supports changing the policy.
- The IP limiter from PR #4 is deferred until the trusted reverse-proxy topology and Express `trust proxy` configuration are explicit. Do not accidentally rate-limit every visitor as one proxy IP.
- Usage must distinguish provider-reported token counts from tokenizer estimates. A character count is not a token count.
- Prefer a lightweight single-instance implementation first. Do not introduce Redis or a distributed quota system before multi-instance operation is required.

## Batch 2 — Model system

| ID | Priority | Task | Status | Completion criteria |
|---|---|---|---|---|
| B2-01 | P0 | Provider management UI | **Complete** | Migration v5 stores managed OpenAI-compatible Providers; AES-256-GCM protects keys at rest; admin-only CRUD/default-model APIs and responsive UI support models, enable/disable and health checks; environment Providers remain read-only and take precedence; all API tests/build passed in CI runs #61/#62 and main run #63. |
| B2-02 | P0 | Model context-window and budget management | **Complete** | Migration v6 persists explicitly reported context windows with 30-day freshness; context-limit provenance distinguishes provider/admin/environment/unknown; supported OpenAI tokenizers are locally estimated and unknown tokenizers use conservative byte upper bounds only when a window is known; per-model input budget preserves the current message and trims older history; configurable output reserve is sent with model-appropriate provider parameters; context policy/truncation is visible in chat; CI run #67 passed API tests and production build. |

Automatic model discovery and on-demand health snapshots are now implemented (migration v11, POST /api/v1/models/discover, admin Provider UI). Remaining model-system follow-ups: controlled failover, native Anthropic API support, and OAuth/browser-session providers such as browser-authenticated coding platforms. Each protocol requires its own adapter and security review; OpenAI-compatible support does not imply compatibility with browser-login providers.

## Batch 3 — NOVA V0.2 AI Workspace

| ID | Priority | Task | Status | Completion criteria |
|---|---|---|---|---|
| B3-01 | P0 | Documents data model and API | **Complete** | Migration v7 adds user-owned Markdown documents with project association, ownership triggers, bounded content and versions; authenticated CRUD/list/search API, optimistic concurrency, account export/deletion lifecycle and regression tests; PR #11 CI run #71 passed API tests and production build; merged as 4866e8e. |
| B3-02 | P0 | Documents editor and autosave | **Complete** | Protected mobile-first Markdown library/editor, edit/preview, project association, 850 ms autosave, optimistic conflict recovery, Markdown export, and Chat action to save a completed assistant answer as a new document with optional project association and direct open link; PR #12 and PR #14 CI passed. |
| B3-03 | P1 | Project context and file management | **Complete** | Migration v8, versioned project instructions, owner-scoped UTF-8 text file upload/download/delete, atomic quotas, explicit context opt-in, bounded untrusted excerpts, protected mobile-first UI, Chat context status, account export/deletion, and cross-account tests. PR #13 CI run #86 passed 33/33 API tests and production build. | Instructions are versioned; TXT/MD/CSV/JSON files are UTF-8 validated, limited to 2 MiB each and 10 MiB/20 files per project, default off for AI context, and isolated by account/project ownership. |
| B3-04 | P1 | Real Research search and citations | **In progress** | Authenticated SearXNG/Brave adapters, source metadata/filtering, cited Markdown collection into Documents, model-drafted cited briefs over user-selected sources, per-user 8/min limiter, timeout/size caps and sanitized errors are merged to `main`; 48/48 API tests pass. Live external provider connectivity still cannot be verified from this environment (no outbound egress). Saved research reports now separate retrieved material, owner synthesis and unverified inference into three labelled sections, and a model-drafted, citation-indexed brief over user-selected sources is available (explicitly labelled as model synthesis, separate from retrieved facts). Autonomous research planning remains unimplemented. |

Target work loop: **Create project → chat with AI → generate document → save it into the project → continue editing.**

Documents comes before project context/file management, and Research follows those foundations. Do not treat sample Research content as real search results.

## Batch 4 — Security, device validation, and release

| ID | Priority | Task | Status | Completion criteria |
|---|---|---|---|---|
| B4-01 | P0 | Security, backup, and Android verification | **Complete (automation scope)** | CSP enabled for API and document responses, production mutations require a trusted Origin, expired sessions are purged, migration v9 adds admin audit logs, error monitoring aggregates stable codes with request IDs, `db:backup`/`db:restore`/`db:verify` implement verified backup and rollback-safe restore, and `npm run e2e` drives 17 browser checks in CI. See `docs/audits/B4-01-VERIFICATION.md` and `docs/DEPLOYMENT.md`. Independent penetration testing, full Git-history secret scanning, external alerting, and Android device acceptance remain open and are listed as release gates, not as completed items. |

## Definition of Done

1. Relevant API/UI tests pass, including negative cross-account tests for ownership-sensitive features.
2. Loading, empty, error, retry, and cancellation states are present.
3. CI dependency install, API tests, and production build pass.
4. No real API keys, user-private content, database files, or generated secrets are committed.
5. Usage and model-health labels reflect evidence; unknown values are not presented as verified.
6. Documentation and the task status are updated in the same change.
7. Version numbers are changed only when the corresponding release scope has passed acceptance.

## 2026-11-07 — B2-01 implementation in progress

- Added migration v5 for database-managed OpenAI-compatible Providers and a persisted default-model setting.
- Added AES-256-GCM encryption for stored Provider API keys. The dedicated `PROVIDER_ENCRYPTION_KEY` is required for create/update operations; the browser receives neither plaintext keys nor ciphertext.
- Added administrator-only list/create/update/delete/default-model endpoints. Environment-configured Providers remain read-only and retain precedence.
- Added the first responsive Provider management screen under Admin, including model catalog editing, enable/disable, default selection, and read-only health probes.
- Added integration coverage for role enforcement, ciphertext-at-rest, secret redaction, upstream health checks, environment precedence, and model disable/delete behavior. Keep B2-01 in progress until all branch CI checks pass.

## 2026-11-07 — B2-01 completed

- Added SQLite migration v5 for managed Providers and persistent default model settings.
- Admin-only APIs and a responsive Admin screen support adding, editing, disabling, deleting, and selecting OpenAI-compatible Providers/models.
- Provider API keys are stored using AES-256-GCM; the dedicated `PROVIDER_ENCRYPTION_KEY` is required and must be backed up securely. Neither plaintext nor ciphertext leaves the server.
- Environment-defined Providers remain read-only and take precedence over database-managed IDs.
- Added regression tests for administrator permissions, production HTTPS validation, secret redaction, encrypted storage, health checks, environment precedence, default model selection, and disable/delete behavior.
- PR #9 merged as `8a0c6c65117abf3ba4a0eb9c3c82d3b60f0bda46`; PR CI runs #61/#62 passed and post-merge main CI run #63 passed.

## 2026-11-07 — B2-02 completed; B3-01 started

- PR #10 merged as `463e356c85c67091404b2d76d5c79eff65613e23`.
- Migration v6 stores explicitly reported model context windows; values are refreshed by read-only model-catalog health checks and ignored after 30 days.
- The request path applies model-aware input budgets, a configurable safety margin and output reserve, and a global character ceiling; it keeps the current user message intact and trims only older complete history.
- Token source/provenance is explicit: local tokenizer estimate, conservative UTF-8 byte upper bound, or unknown. The provider output cap uses the configured OpenAI-compatible parameter and can be overridden/disabled per model.
- Chat responses/UI expose context policy and history truncation; regression tests cover oversized messages, reasoning/non-reasoning output fields, provider opt-out, and model context provenance. PR CI run #67 passed API tests and production build.
- B3-01 is now in progress: implement owned Documents schema and API as the first NOVA 0.2 workspace foundation.

## 2026-11-07 — B3-01 implementation in progress

- Added migration v7 with a user-owned Markdown documents table, project association, content/title constraints, update version, indexes, and SQLite ownership triggers.
- Added authenticated list/create/read/update/delete API endpoints under `/api/v1/documents`; all reads and writes are owner-scoped and cross-account access returns 404.
- Updates require `expectedVersion` and return 409 on stale writes, providing the concurrency contract needed by the upcoming autosave editor.
- Deleting a project detaches its documents rather than deleting them; account deletion cascades documents. Account export schema v5 now contains complete document content.
- Added integration coverage for CRUD, search/pagination, project ownership, stale version conflicts, project deletion, account export, and account deletion. B3-01 remains in progress until CI passes.

## 2026-11-07 — B3-01 completed; B3-02 started

- PR #11 merged as `4866e8eb4184b18f209535a9fa6b31436afb1619`; CI run #71 passed the API test suite and frontend production build.
- Migration v7 adds private Markdown documents with owner/project constraints, version numbers, and indexes. API list/create/read/update/delete is owner-scoped; stale updates return 409 and require the caller's expected version.
- Project deletion detaches documents rather than deleting them; account deletion cascades documents; account export schema v5 includes full document content.
- B3-02 is now in progress: build the mobile-first Documents list/editor and reliable autosave over the versioned API. Preserve unsaved local text on conflicts and expose actionable save state.

## 2026-11-07 — B3-02 editor implementation in progress

- Added protected `/documents` and `/documents/:id` routes and a logged-in Documents navigation entry.
- Added a private document library with title search, recent ordering, create and refresh actions.
- Added a mobile-first Markdown editor with edit/preview modes, project association, character limit, save status, and Markdown download.
- Autosave debounces edits by 850 ms and sends the document's current `expectedVersion`; transient failures wait for an explicit retry or a new edit rather than retrying forever.
- A 409 version conflict preserves the local editor state and offers reload-latest or save-as-copy recovery. B3-02 remains in progress until CI and interaction checks pass.

## 2026-11-07 — B3-02 completed; B3-03 started

- PR #12 merged to main with the mobile-first Documents library/editor, Markdown preview/export, project association and optimistic-concurrency autosave.
- Autosave runs after an 850 ms typing pause; failures wait for a new edit or explicit retry. A 409 conflict preserves the local editor buffer and offers reload-latest or save-as-copy.
- PR CI run #74 and post-merge main CI run #75 both passed API tests and the production client build.
- B3-03 is in progress: project instructions and opt-in project materials, with upload size/type/content validation, account isolation, storage lifecycle and bounded context injection.

## 2026-11-07 — B3-03 implementation in progress

- Migration v8 adds versioned project instructions and owner-scoped project file records with content hashes, bounded sizes and database ownership triggers.
- Added project context endpoints for instruction read/update, file list/upload/download/delete and explicit `includeInContext` opt-in. Upload quotas are enforced transactionally (20 files / 10 MiB per project; 2 MiB per file).
- Linked project conversations now receive only same-account project instructions and explicitly selected file excerpts, bounded to 4 files / 12,000 characters. File excerpts are labelled untrusted reference material; project context is omitted rather than displacing the current user message when the budget cannot fit it.
- Added a responsive Project Context UI for project instruction editing, upload, download, delete and context opt-in. Chat status reports whether project context/files were included, omitted or truncated.
- Regression tests cover owner isolation, file validation/deduplication, project deletion, account export/deletion and prompt-context opt-in. B3-03 remains in progress pending CI.

## 2026-11-07 — B3-03 completed

- PR #13 adds migration v8 for versioned project instructions and private project files with ownership triggers.
- Added owner-scoped instruction/file APIs, optimistic version conflicts, UTF-8 validation, JSON validation, SHA-256 duplicate detection, and transactional limits (2 MiB/file, 20 files and 10 MiB/project).
- Files remain excluded from AI context until explicitly enabled. Linked conversations receive only same-owner project context; selected excerpts are bounded and labelled untrusted. Context is omitted rather than displacing the current user message when it cannot fit.
- Added the Project Context index/editor to protected React routes and signed-in navigation. Uploads use the configured API origin, include session credentials, and are covered by CORS request-header allowlisting.
- Account export includes project instructions and file contents; account deletion cascades project files. Regression tests cover ownership, validation, opt-in, prompt-context construction, downloads, and project/account lifecycle.
- PR #13 CI run #85 passed: 33/33 API tests and the production client build. Merge PR #13 before starting B3-04 Research search.

## 2026-11-07 — Chat → Documents workflow completed

- PR #14 adds a save action to every completed assistant answer in Chat. The saved document preserves the original Markdown content and suggests a title from the preceding user prompt.
- Users can save to their private Documents library or associate the document with one of their owned projects. The existing owner-scoped Documents API validates project ownership; no new table or migration is required.
- After a successful save, the answer offers a direct link to open the new document. The dialog handles project-list/save errors and enforces the existing 120-character title and 200,000-character content limits.
- PR #14 CI run #90 passed: 33/33 API tests and production Vite build. Real Android interaction remains part of B4-01 device verification.

## Completed work log

### 2026-11-07 — B1-01

- Compared PR #4 with current `main`; identified the old branch as diverged and did not merge it.
- Retained main's stricter 6 requests/minute per-user limit, single in-flight generation guard, and existing SSE disconnect cancellation.
- Ported missing non-streaming JSON request cancellation into PR #5. A client disconnect now aborts the upstream Provider request; no incomplete turn is persisted, and the generation lock is released.
- Added an integration test covering upstream closure, no partial persistence, and successful retry after cancellation.
- CI passed on PR #5 (run 36) and again after merge on main (run 37).
- Merged as `f4d48025919a98f797fee3cd5d9460535899cd09`. Closed PR #4 as superseded, not merged.
- Deferred IP-based limiting until trusted reverse-proxy handling is explicitly configured.

## 2026-11-07 — B1-02 / B1-03 implementation in progress

- Provider errors are now normalized into distinct codes for credential/permission rejection, request rejection, upstream rate limiting, upstream outage, network failure, timeout, malformed JSON, malformed SSE, provider stream errors, empty completions, and client cancellation.
- The Provider adapter reads token usage only when it is explicitly returned by the upstream response or stream event; it does not treat character counts as tokens.
- Added migration v3 for `ai_usage`, with request ID, user/provider/model, operation, status, error category, duration, provider-reported token counts, and timestamps. No prompts, response text, API keys, or base URLs are stored.
- All four generation paths now create and finalize usage records: JSON chat, SSE chat, edit/regenerate, and failed-response retry.
- Account data export includes owned usage records; account deletion cascades them. Administrator-only `GET /api/v1/admin/usage` returns aggregate and recent records.
- Added tests for Provider error redaction/classification, schema migration, streaming usage metadata, export/deletion lifecycle, and admin authorization. Do not mark these tasks complete until branch CI passes.

## 2026-11-07 — B1-02 / B1-03 completed

- Provider adapter normalizes upstream 401/403, 408/504, 429, 5xx, other 4xx, network failures, invalid JSON, invalid SSE frames, provider stream errors, empty completions, timeouts, and client cancellation into stable NOVA codes.
- Raw upstream error bodies, private diagnostics, API keys, and Provider base URLs are not returned to the client or stored in Usage records. JSON errors and SSE terminal events include a request reference where available.
- SQLite migration v3 creates `ai_usage`; all four generation paths (legacy JSON chat, SSE chat, edit/regenerate, retry) now record in-progress and terminal lifecycle states.
- Token counts are populated only from upstream `usage` metadata. Providers that do not report usage leave token fields null. NOVA does not infer token counts from character lengths or calculate unsupported monetary costs.
- Usage history is included in each account's JSON export, is deleted with the account, and is visible in an administrator-only aggregate/recent-record endpoint. The endpoint exposes metadata only, not prompts or response bodies.
- Tests cover migration, streaming and JSON token metadata, error redaction/classification, failed/cancelled usage, edit/retry accounting, export/deletion lifecycle, and administrator authorization.
- GitHub Actions run #43 passed: API integration tests and production web build both succeeded.
- Package version remains `0.1.0`; no release version change was made.

## 2026-11-07 — B1-04 completed

- Added `rehype-highlight` to the existing ReactMarkdown/remark-gfm pipeline, with 13 selectively registered language grammars and common aliases. Inline code and non-code Markdown remain on the existing renderer path.
- Added a dedicated fenced-code toolbar with language label and per-block copy. Copy uses the browser clipboard API for only the selected code block and reports copied/failed state accessibly.
- Added NOVA light/dark theme-aware syntax colors, responsive horizontal scrolling, and mobile-sized code typography.
- Highlighting is dynamically loaded only when a message contains a fenced code block. Vite output: Chat route chunk 14.27 kB (gzip 5.43 kB); isolated highlighter chunk 168.54 kB (gzip 54.24 kB); main entry 265.27 kB (gzip 84.83 kB).
- GitHub Actions run #50 passed: dependency install, API tests, and production web build.

## 2026-11-07 — B1-05 implementation in progress

- Added SQLite migration v4 for `message_versions`, linked to assistant messages with cascade deletion.
- Successful edit/regeneration archives the replaced assistant answer and carries forward any earlier versions before the old branch is removed.
- Successful retry archives the former failed/cancelled response and preserves its prior versions. Failed/cancelled replacements do not modify history.
- Added owner-scoped version list and restore APIs. Restore swaps the selected historical answer with the current answer so both remain recoverable.
- Account export includes version content; deleting a parent message/account cascades the saved versions.
- Added a Chat history panel with source/time/preview and a restore action. Final acceptance is pending CI validation.

## 2026-11-07 — B1-05 completed

- Added SQLite migration v4 for `message_versions` with parent-message cascading deletion and indexed version lookup.
- Successful edit/regeneration archives the assistant answer that was replaced and carries forward older versions. Successful retry archives the former failed/cancelled answer in the new message history.
- Failed/cancelled edit and retry paths leave the original visible answer and saved history untouched.
- Added owner-scoped `GET /api/v1/conversations/:id/messages/:messageId/versions` and `POST /api/v1/conversations/:id/messages/:messageId/restore`. Restore swaps the selected historical answer with the current answer, retaining both so users can switch back and forth.
- Chat now shows a history panel with source, timestamp, preview, and restore control only when saved versions exist.
- Account export includes answer-version text; deleting the message/account cascades the associated versions.
- CI run #55 passed: npm ci, all API integration tests, and the production web build.
- Package version remains `0.1.0`; no release version change was made.


## 2026-11-07 — Next-stage implementation review

- Kept PR #15 open and unmerged. No changes were made to its branch or the `main` branch.
- Opened Draft PR #16 from `feat/research-search-workspace` for Research web search, cited source organization, Documents reliability fixes, and source/mobile review.
- Research now has a server-only SearXNG/Brave adapter, authenticated search API (8 requests/user/minute), request timeout/response-size limits, URL validation/deduplication, metadata preservation, and sanitized provider errors. Without a configured provider it returns `RESEARCH_SEARCH_NOT_CONFIGURED`; no sample/fake search results are used.
- Research UI preserves the editorial CMS and adds a separate network-search view. Users can select actual returned sources, attach notes, and save a Markdown research record with URLs and citation index into their private Documents library.
- CI run #95 passed: `npm ci`, 38/38 API tests, and `npm run build`. Tests verify authentication, missing-provider behavior, SearXNG normalization/filtering, Brave server-side credential handling, upstream error redaction, and administrator-only Research publishing. Provider responses are stubbed/local in CI; real external service connectivity remains unverified until deployment is configured.
- Documents gained archive/restore: migration v10 adds `documents.archived_at`; the list API accepts `archived=active|archived|all` and returns `archivedCount`; the library and editor expose version-checked archive/restore, and account export includes `archivedAt`.
- Documents list refresh was calling an undefined `load()` function; PR #16 replaces it with a shared loader. Project-list failures no longer prevent the document itself from opening; unsaved browser unload warnings, conflict reload confirmation, and save/delete state guards were added.
- Static security and Android layout review is documented separately. No database migrations, authentication architecture, Provider storage, or ownership model were changed by this stage.
- Real Android browser/device acceptance remains deferred per project policy. Keep PR #16 as Draft and do not merge until review and later acceptance.

## 2026-11-07 — Latest remote integration and B4-01 hardening

- Pulled the two newest remote branches and merged them into `main`: `feat/research-search-workspace` (fast-forward, Research search + Documents reliability) and `fix/chat-no-provider-guidance` (merge commit; resolved one `client/src/styles/chat.css` conflict by keeping both the mobile touch-target block and the model-state block).
- Client API base URL now defaults to the same origin when the API process serves `client/dist`; only the Vite dev server on :5173 keeps pointing at :4000.
- `createApp()` keeps the API contract; new `attachClientBuild()` serves the production build with SPA deep-link fallback and document-level CSP.
- SEC-05: Helmet CSP enabled with a deny-by-default policy for API responses; `index.html` receives the document policy (self scripts, Google Fonts, `connect-src` from `WEB_ORIGIN`).
- SEC-08: in production a state-changing request without `Origin` is rejected with `MISSING_ORIGIN`; untrusted origins still get `INVALID_ORIGIN`.
- SEC-09: expired sessions are purged on login/registration, at boot, and every 6 hours.
- SEC-10: migration v9 adds `admin_audit_logs`. Role changes, Provider create/update/delete, default-model changes and Research article writes are recorded after passing through a sanitizer that drops keys, ciphertext, base URLs and user content.
- Model discovery: admin-only POST /api/v1/models/discover performs a read-only GET against the provider /models endpoint and returns discovered IDs with context windows and an alreadyConfigured flag; the Provider editor can append them to the JSON draft. Health probes persist a 24h snapshot (migration v11 model_health_snapshots) reported by the catalog as status/statusLabel/healthCheckedAt; older snapshots are ignored so a stale probe is never presented as current.
- Error monitoring: every response carries `X-Request-Id`; failures are aggregated by stable NOVA error code and exposed through `GET /api/v1/admin/monitoring` (admin only).
- Backup/restore: `npm run db:backup` uses the SQLite online backup API, runs `PRAGMA integrity_check`, writes a sha256 manifest and prunes old copies; `db:restore` keeps a `pre-restore` rollback copy; `db:verify` checks any database file.
- TD-19: `npm run e2e` drives the built client with system Chromium through puppeteer-core — 17 checks covering registration, session persistence, Chat unconfigured-model guidance, Studio project creation, document autosave + reload persistence, 360 px layout, mobile drawer, and the Admin monitoring/audit/provider panels. CI gained a `browser-smoke` job using `browser-actions/setup-chrome`.
- Admin UI gained 审计日志 and 错误监控 tabs backed by the new endpoints.
- Verification record: `docs/audits/B4-01-VERIFICATION.md`. Deployment/backup runbook: `docs/DEPLOYMENT.md`.
- Honest limits: no outbound network in this environment, so real SearXNG/Brave connectivity, external alert delivery, independent penetration testing, full Git-history secret scan and Android device acceptance remain unverified and are listed as open release gates.


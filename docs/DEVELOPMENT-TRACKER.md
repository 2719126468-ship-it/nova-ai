# NOVA AI Development Tracker

- Updated: 2026-11-07
- Product stage: V0.1 core quality work → V0.2 AI Workspace
- Repository baseline: `main`
- Package version: keep `0.1.0` until release acceptance; do not bump for planning milestones.

## Progress

**9 / 12 complete** · 1 in progress · 2 planned

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

Remaining model-system follow-ups: automatic model discovery, controlled failover, native Anthropic API support, and OAuth/browser-session providers such as browser-authenticated coding platforms. Each protocol requires its own adapter and security review; OpenAI-compatible support does not imply compatibility with browser-login providers.

## Batch 3 — NOVA V0.2 AI Workspace

| ID | Priority | Task | Status | Completion criteria |
|---|---|---|---|---|
| B3-01 | P0 | Documents data model and API | **Complete** | Migration v7 adds user-owned Markdown documents with project association, ownership triggers, bounded content and versions; authenticated CRUD/list/search API, optimistic concurrency, account export/deletion lifecycle and regression tests; PR #11 CI run #71 passed API tests and production build; merged as 4866e8e. |
| B3-02 | P0 | Documents editor and autosave | **Complete** | Protected Documents library and mobile-first Markdown editor, edit/preview, project association, 850 ms debounced autosave with optimistic version checks, save/error/conflict states, reload-latest and save-as-copy recovery, and .md download; PR #12 CI run #74 and post-merge main CI run #75 passed; merged to main. |
| B3-03 | P1 | Project context and file management | **In progress** | Add project instructions and organized project materials; implement upload only with file type/signature, size, isolation, retention, and parsing controls. |
| B3-04 | P1 | Real Research search and citations | Planned | Use a real search provider, preserve source URLs/metadata, distinguish retrieved facts from model synthesis, and produce cited reports. |

Target work loop: **Create project → chat with AI → generate document → save it into the project → continue editing.**

Documents comes before project context/file management, and Research follows those foundations. Do not treat sample Research content as real search results.

## Batch 4 — Security, device validation, and release

| ID | Priority | Task | Status | Completion criteria |
|---|---|---|---|---|
| B4-01 | P0 | Security, backup, and Android verification | Planned | Tighten CSRF/Origin/CSP, add admin audit and API/error monitoring, rehearse SQLite backup/restore, run Playwright E2E, and verify key flows in Android browsers including the Mate 20 Pro. |

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

# NOVA AI Development Tracker

- Updated: 2026-11-07
- Product stage: V0.1 core quality work → V0.2 AI Workspace
- Repository baseline: `main`
- Package version: keep `0.1.0` until release acceptance; do not bump for planning milestones.

## Progress

**1 / 12 complete** · 2 in progress · 9 planned

The existing V0.1 implementation is the foundation. Do not rebuild or replace working authentication, chat, SSE, model routing, Studio, account, or data-lifecycle flows. Extend them incrementally.

## Batch 1 — V0.1 core finish

| ID | Priority | Task | Status | Completion criteria |
|---|---|---|---|---|
| B1-01 | P0 | Review PR #4 against current main and selectively integrate valid changes | **Complete** | Old PR was not merged directly. The non-streaming disconnect cancellation was ported to current main in PR #5; regression test and CI passed. Existing 6/min per-user limiter and single-generation guard were retained. |
| B1-02 | P0 | Review and consolidate Provider error handling | In progress | Normalize HTTP, timeout, malformed-stream, empty-response, cancellation, and quota errors. Keep secrets and upstream private details out of client responses and logs; tests cover each category. |
| B1-03 | P0 | Design and implement persistent Usage records | In progress | Persist request ID, user, provider/model, status, duration, and actual upstream usage when supplied. Unknown token/cost values must remain unknown, not be guessed. |
| B1-04 | P1 | Add code syntax highlighting and code-block copy | Planned | Common languages render correctly; copy action copies only code content; mobile layout remains usable. |
| B1-05 | P1 | Add assistant answer version history and undo | Planned | Replaced answers remain recoverable; users can inspect and restore a prior answer without corrupting conversation order or context. |

### Batch 1 implementation notes

- Keep the current main-branch per-user generation limiter at 6 requests/minute and its single active-generation guard unless measured evidence supports changing the policy.
- The IP limiter from PR #4 is deferred until the trusted reverse-proxy topology and Express `trust proxy` configuration are explicit. Do not accidentally rate-limit every visitor as one proxy IP.
- Usage must distinguish provider-reported token counts from tokenizer estimates. A character count is not a token count.
- Prefer a lightweight single-instance implementation first. Do not introduce Redis or a distributed quota system before multi-instance operation is required.

## Batch 2 — Model system

| ID | Priority | Task | Status | Completion criteria |
|---|---|---|---|---|
| B2-01 | P0 | Provider management UI | Planned | Authorized administrators can add/edit/disable providers and models without exposing secrets to the browser; validate configuration and show honest connection state. |
| B2-02 | P0 | Model context-window and budget management | Planned | Enforce configured model context limits; distinguish provider-reported limits, tokenizer estimates, and unknown values; preserve the current user message and explain truncation/limits. |

Additional model-system follow-ups, after the two P0 tasks: tokenizer-based estimation, health-state persistence/refresh, automatic model discovery, controlled failover, native Anthropic API support, and OAuth/browser-session providers. Each protocol requires its own adapter and security review; OpenAI-compatible support does not imply compatibility with browser-login providers.

## Batch 3 — NOVA V0.2 AI Workspace

| ID | Priority | Task | Status | Completion criteria |
|---|---|---|---|---|
| B3-01 | P0 | Documents data model and API | Planned | Add owned documents with project association, create/read/update/delete endpoints, validation, migrations, and cross-account tests. |
| B3-02 | P0 | Documents editor and autosave | Planned | Create/edit Markdown documents, autosave safely, show save/error state, and export content. |
| B3-03 | P1 | Project context and file management | Planned | Add project instructions and organized project materials; implement upload only with file type/signature, size, isolation, retention, and parsing controls. |
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

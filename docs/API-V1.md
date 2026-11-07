# NOVA API v1

Status: the first versioned API contract shipped with the V0.1 streaming foundation.

## Compatibility

- New clients should use the /api/v1 prefix.
- Existing /api routes remain mounted as compatibility aliases during the migration period.
- Both prefixes use the same HttpOnly session cookie and request-origin protections.
- JSON mutation requests must send X-Requested-With: NOVA-Web.

## Health and models

### GET /api/v1/health

Returns API health and whether the server has a complete AI provider configuration. It does not perform an upstream connectivity check.

### GET /api/v1/models

Returns the server-side model catalog. The response contains providers, models, defaultModelId and contextPolicy. API keys and provider base URLs are never returned. The top-level provider object reports configuration separately from upstream health; configured providers remain health: unknown until a real probe is run. The health endpoint returns ai.status as configured_unverified or not_configured. Model entries expose context-window provenance and tokenizer/output-limit configuration without exposing credentials.

### POST /api/v1/models/health

Requires an authenticated session and is limited to 5 checks per user per minute. Body: `{ "modelId": "provider-id:upstream-model-id" }`. The server makes a read-only authenticated GET request to the Provider's `/models` endpoint; it never generates a prompt or spends completion tokens. It returns `healthy` only when the upstream catalog confirms the exact upstream model ID. When that model entry explicitly returns a positive integer context field (`context_length`, `context_window`, `max_context_length`, `max_model_len`, or their camelCase equivalents), NOVA stores it as `provider_reported` and uses it ahead of a manually configured hint. A provider that does not support `/models`, returns an unrecognized catalog, or omits a context field remains healthy/unknown as appropriate but does not create a verified window. Authentication failures/server errors report `unavailable`; upstream 429 reports `degraded`. The result is an on-demand observation, not a persisted long-term health guarantee.

A configured model has this shape:

```json
{
  "id": "configured-model-id",
  "name": "configured-model-id",
  "provider": "openai-compatible",
  "configured": true,
  "enabled": true,
  "selectable": true,
  "status": "unknown",
  "statusLabel": "NOT_CHECKED",
  "capabilities": ["chat", "text"],
  "contextLimit": 98304,
  "contextLimitSource": "provider_reported",
  "contextLimitCheckedAt": "2026-11-07T00:00:00.000Z",
  "tokenizer": "auto",
  "tokenizerSource": "automatic",
  "maxTokensParameter": "auto"
}
```

`contextLimit` is the best available context-window value. `contextLimitSource` is one of `provider_reported`, `admin_configured`, `environment_configured`, or `unknown`. A provider-reported value is taken only from an explicit upstream model-catalog field during a health probe; admin/environment values are deployment hints and are not independently verified. A provider-reported value takes precedence over configured hints.

`tokenizer` supports `auto`, `cl100k_base`, `o200k_base`, and `none`. Automatic selection is intentionally limited to recognized OpenAI model families; third-party compatible models should be assigned their actual tokenizer by an administrator when known. `maxTokensParameter` supports `auto`, `max_tokens`, `max_completion_tokens`, and `none`; `auto` selects the completion parameter based on the upstream model family. Choose `none` only when the provider rejects both common completion-limit fields.

Model IDs returned by the catalog are the public selection IDs; multi-provider IDs use providerId:upstreamModelId. status: unknown means that the model is configured but has not been actively verified. Do not present this state as connected, healthy, or available. The registry supports OpenAI-compatible providers from server environment configuration and encrypted administrator-managed records. Environment-defined providers remain read-only in the admin UI and take precedence over database records with the same ID. Native Anthropic protocol support, browser-login/OAuth providers and automatic model discovery remain unimplemented.

Malformed AI_PROVIDERS_JSON disables the environment-defined provider set and reports AI_PROVIDERS_JSON_INVALID; it does not silently fall back to legacy environment credentials. Valid database-managed providers can still be loaded.

## Provider administration

The following endpoints require an authenticated administrator session.

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/admin/providers | List database-managed and read-only environment-defined providers without returning credentials |
| POST | /api/v1/admin/providers | Add an OpenAI-compatible provider and its model catalog |
| PUT | /api/v1/admin/providers/:id | Update a database-managed provider; an omitted/blank API key keeps the existing credential |
| DELETE | /api/v1/admin/providers/:id | Delete a database-managed provider and clear its selected default when necessary |
| PUT | /api/v1/admin/model-default | Set or clear the default selectable model |

Database-managed Provider API keys are encrypted at rest with AES-256-GCM. Set `PROVIDER_ENCRYPTION_KEY` to at least 32 random characters before using provider management (for example, generate one once with `openssl rand -hex 32`). Keep this key in the server's secret environment and preserve it in secure backups. Replacing or losing it makes existing encrypted Provider credentials unreadable. The key, plaintext API keys and ciphertext are never returned to the browser; the admin view receives only a `hasApiKey` flag.

Provider base URLs must be valid and cannot contain embedded usernames/passwords, query strings or fragments. Production deployments require HTTPS. Environment-defined providers are displayed as read-only; the admin UI cannot overwrite or delete them. When IDs conflict, environment configuration wins.

The default model priority is `AI_DEFAULT_MODEL` / legacy `AI_MODEL`, then the database-managed default, then the first selectable model. Environment-controlled defaults cannot be overridden from the admin UI. A health check uses the existing read-only `GET /models` probe; it does not send a completion prompt.

## Context budget

NOVA applies both a global message-content guard and a model-aware token budget.

- `AI_MAX_CONTEXT_CHARS` (default `40000`, allowed `512`–`200000`) is a JavaScript string-length ceiling, not a token count.
- `AI_CONTEXT_OUTPUT_RESERVE` (default `2048`, allowed `128`–`100000`) is sent upstream as the maximum completion length when the provider accepts the configured completion-limit parameter.
- `AI_CONTEXT_SAFETY_MARGIN_PERCENT` (default `10`, allowed `0`–`30`) keeps a margin for chat framing and tokenizer differences.

When a model has a known or configured context window, NOVA calculates the input allowance as `floor(contextLimit × (1 − safetyMargin)) − outputReserve`. It uses a local `js-tiktoken` estimate for supported OpenAI tokenizers. Automatic inference covers only recognized GPT model families; assign `cl100k_base` or `o200k_base` explicitly for other compatible providers when their tokenizer is known. If the tokenizer is unknown but a context window is available, NOVA uses a conservative UTF-8 byte upper bound for admission/truncation. This is deliberately labelled as an upper bound, not as a measured token count. If no context window is available, NOVA falls back to the character ceiling and reports the token count as unknown.

NOVA always keeps the current user message intact and removes only older complete history messages that do not fit. It considers at most the newest 30 completed messages; an unmatched trailing user message from a failed/cancelled turn is not replayed. If the current message alone exceeds the character or input-token allowance, the API returns HTTP 413 `AI_INPUT_TOO_LARGE` before calling the provider. The error includes the same `contextPolicy` fields used by a successful request.

The Chat UI explains whether history was shortened, shows the best available context-window source, labels local tokenizer estimates separately from byte upper bounds, and shows the input and output allowances. Streaming `message_start` includes `contextPolicy`; the legacy JSON response includes it as well.

## Account data

These endpoints require an authenticated session.

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/auth/export | Download the current user's account and workspace data as JSON |
| DELETE | /api/v1/auth/me | Delete the current account after password and email confirmation |

The export contains profile metadata, projects, conversations, messages, project/conversation links, and articles authored by the account. It deliberately excludes password hashes, session tokens/hashes, and Provider API keys. The response uses Cache-Control: no-store.

Deletion requires both the current password and the exact account email. It removes the user, active sessions, projects, conversations, messages and project links through SQLite foreign-key cascades. Published Research CMS content is retained as site content and its author_id is set to null; this is explained before submission in the Account UI.

## Projects

All project endpoints require an authenticated session and scope data to the current user.

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/projects | List owned projects, including linked conversation counts |
| POST | /api/v1/projects | Create a project |
| GET | /api/v1/projects/:id | Read an owned project and its linked conversation count |
| PUT | /api/v1/projects/:id | Update an owned project |
| DELETE | /api/v1/projects/:id | Delete an owned project (links are cascade-deleted; conversations remain) |
| GET | /api/v1/projects/:id/conversations | List conversations linked to a project |
| POST | /api/v1/projects/:id/conversations | Link an owned conversation to an owned project |
| DELETE | /api/v1/projects/:id/conversations/:conversationId | Remove only the project link |

A project and conversation can be linked only when both belong to the authenticated user. Cross-account project/conversation combinations return 404. Duplicate links are idempotent. Removing a link does not delete the conversation or its messages; deleting a project removes its link rows through foreign-key cascade. Deleting a conversation also removes its link rows. Documents linked to a deleted project are preserved and detached; their projectId becomes null.

## Documents

All Document endpoints require an authenticated session. Every query and mutation is scoped to the current user.

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/documents | List owned documents with optional `projectId`, title query `q`, `limit` (1–100) and `offset` |
| POST | /api/v1/documents | Create a Markdown document, optionally associated with an owned project |
| GET | /api/v1/documents/:id | Read an owned document including its Markdown content and version |
| PUT | /api/v1/documents/:id | Update title/content/project association using a required `expectedVersion` |
| DELETE | /api/v1/documents/:id | Delete an owned document |

Create body: `{ "title": "Meeting notes", "content": "# Notes", "projectId": 12 }`. `projectId` is optional or null. Titles are trimmed and limited to 120 characters; Markdown content is limited to 200,000 JavaScript characters. List responses omit content and return `contentLength`; read/create/update responses return the complete document.

Updates must include the version previously read: `{ "content": "# Updated", "expectedVersion": 3 }`. Each successful update increments `version`. A stale version returns HTTP 409 `DOCUMENT_VERSION_CONFLICT` with the current version; clients should fetch and reconcile before retrying, rather than silently overwriting newer edits.

A document may be linked only to a project owned by the same account. API ownership checks and SQLite triggers both enforce this rule. Attempts to read, modify, or delete another user's document return 404. Deleting a project preserves owned documents and clears `projectId`; deleting an account cascades its owned documents. Account export includes the complete Markdown body and increments its schema version to 5.

## Project context and files

All endpoints below require an authenticated session and are scoped to the owner of the project.

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/projects/:id/context | Read project instructions, instruction version, and file metadata |
| PUT | /api/v1/projects/:id/context | Update project instructions using `expectedVersion` |
| GET | /api/v1/projects/:id/files | List project file metadata without returning file content |
| POST | /api/v1/projects/:id/files | Upload one UTF-8 text file as `application/octet-stream` |
| PATCH | /api/v1/projects/:id/files/:fileId | Set `includeInContext` to explicitly opt a file into linked project conversations |
| GET | /api/v1/projects/:id/files/:fileId/download | Download the original uploaded file |
| DELETE | /api/v1/projects/:id/files/:fileId | Delete an owned project file |

Project instruction updates require `{ "instructions": "...", "expectedVersion": 1 }`. Instructions are limited to 16,000 JavaScript characters. Successful updates increment `instructionsVersion`; stale versions return HTTP 409 `PROJECT_CONTEXT_VERSION_CONFLICT`.

Uploads accept only `.txt`, `.md`, `.csv`, and `.json` files containing valid UTF-8 text (JSON files must parse). A file is limited to 2 MiB; a project may contain at most 20 files and 10 MiB in total. File names are sanitized, file contents are hashed, and duplicate content in the same project returns 409. Project ownership is checked by the API and SQLite triggers. File contents are never returned in metadata endpoints.

Every file is uploaded with `includeInContext=false`. The owner must explicitly opt a file in. When a conversation is linked to a project, NOVA may add the project's instructions and selected text excerpts to the prompt; the context is restricted to the same account, at most 4 files and 12,000 characters total. Project instructions are bounded separately. Selected file content is labelled as untrusted reference material and must not be treated as instructions. If the project context does not fit alongside the current user message and model budget, NOVA omits the project context rather than truncating the current message. The chat `contextPolicy` describes whether project context/files were included, omitted or truncated.

Account export schema version 6 includes project instructions, their version, and base64-encoded project file contents. Account deletion removes project files through the user/project foreign-key lifecycle.

## Conversations

All endpoints below require an authenticated session.

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/conversations | List the current user's conversations |
| POST | /api/v1/conversations | Create a conversation |
| GET | /api/v1/conversations/:id | Read a conversation and its messages |
| PATCH | /api/v1/conversations/:id | Rename a conversation |
| DELETE | /api/v1/conversations/:id | Delete a conversation and its messages |
| POST | /api/v1/conversations/:id/messages/stream | Send a message and stream the assistant response |
| PUT | /api/v1/conversations/:id/messages/:messageId/stream | Edit a previous user message and stream its replacement response |
| POST | /api/v1/conversations/:id/messages/:messageId/retry/stream | Retry the latest failed/cancelled assistant response |
| GET | /api/v1/conversations/:id/messages/:messageId/versions | List prior versions of an assistant answer |
| POST | /api/v1/conversations/:id/messages/:messageId/restore | Restore a selected prior answer version |

The conversation owner is checked on every operation. A user cannot read, rename, send messages to, or delete another user's conversation.

### Streaming request

```http
POST /api/v1/conversations/123/messages/stream
Content-Type: application/json
Accept: text/event-stream
X-Requested-With: NOVA-Web
```

```json
{
  "content": "Explain this idea",
  "modelId": "configured-model-id"
}
```

modelId is optional. When supplied, it must match the model enabled by the server configuration. A request made before the provider is configured returns a normal JSON 503 AI_PROVIDER_NOT_CONFIGURED response before the stream starts.

### Editing and regenerating a turn

Use `PUT /api/v1/conversations/:id/messages/:messageId/stream` with the same JSON body and SSE events as the normal streaming endpoint. The target must be a completed user message in a conversation owned by the authenticated user.

Editing a user message changes the conversation branch from that point onward. On successful generation, NOVA atomically updates the selected user message, deletes all later messages, and saves the replacement assistant response. This prevents later answers from remaining attached to a prompt that no longer exists.

The original conversation remains intact while the replacement is being generated. If generation fails or is cancelled, the pending response is discarded and the old conversation branch is preserved, so the user can retry. The Chat UI only offers one-click Regenerate on the latest completed assistant message; editing an earlier user message displays a warning that later turns are removed only after successful regeneration.

### Retrying a failed response

Use `POST /api/v1/conversations/:id/messages/:messageId/retry/stream` for the latest assistant message when its status is `failed` or `cancelled`. The route resolves the immediately preceding completed user question and rebuilds context from completed history before that question.

Only the last message in the conversation can be retried, so an older failure cannot silently erase later conversation turns. The original failed/cancelled response remains stored while the retry runs. On success, NOVA atomically deletes the old failed response and saves the replacement. On another failure or cancellation, the pending retry is discarded and the original failed response remains available. The Chat UI shows Retry only on the final failed/cancelled assistant message.

### Assistant answer versions and restore

A successful edit/regeneration stores the assistant answer that was replaced as a version of the new assistant message. A successful retry similarly preserves the prior failed/cancelled answer. Existing versions are carried forward when the answer is replaced again. Failed or cancelled edits/retries do not change the visible branch or create a replacement version.

Use `GET /api/v1/conversations/:id/messages/:messageId/versions` to list versions for an assistant message. The conversation must belong to the authenticated user and the message must be an assistant answer.

Use `POST /api/v1/conversations/:id/messages/:messageId/restore` with `{ "versionId": 123 }` to restore a selected version. The selected version becomes current, while the previously current answer is saved as a new restorable version. This is a reversible swap, so users can move between the current and earlier answer without losing either. Restoring is blocked while the account has an active generation; a version must belong to the specific assistant message.

The `GET /api/v1/conversations/:id` message objects include `version_count` so clients can show a history control only when versions exist. Answer versions are private user data: they are included in account JSON export and cascade-delete with their parent message or account.

### SSE events

Each event uses the standard event: and data: framing.

| Event | Payload | Meaning |
|---|---|---|
| message_start | userMessage, assistantMessageId, modelId, contextPolicy | The user message and pending assistant message have been persisted; contextPolicy describes the effective budget and any history trimming |
| message_delta | messageId, delta | A new text fragment is available |
| message_complete | assistantMessage | The final assistant text has been saved |
| message_error | messageId, code, message | Generation failed; any partial text is retained (edit/retry operations preserve the previous conversation branch) |
| message_cancelled | messageId, code, message | Generation was cancelled before completion |

An error before response headers are sent is a normal JSON API error. An error after streaming begins is delivered as a message_error event.

### Message lifecycle

The messages.status column is managed by a versioned SQLite migration:

- complete: message is eligible for future conversation context.
- streaming: an assistant response is currently being generated.
- failed: generation ended with an error; partial output is retained for diagnosis and user recovery.
- cancelled: the client disconnected or cancelled the request; partial output is retained.

Only completed messages are sent as prior conversation context. Failed or cancelled partial responses are not silently replayed as if they were complete.

### Cancellation

Some OpenAI-compatible services ignore stream: true and return a normal JSON completion. NOVA relays that single completion as one message_delta, then emits message_complete so compatible deployments can still finish a response.

Clients should use AbortController to cancel the streaming fetch when the user presses Stop or leaves the active stream. The server listens for the response connection closing and aborts the upstream provider request. The pending assistant message is marked cancelled and any received partial content is saved.

## Errors

| Code | HTTP status | Meaning |
|---|---:|---|
| AI_PROVIDER_NOT_CONFIGURED | 503 | No enabled server-side model is configured |
| MODEL_NOT_FOUND | 404 | Requested model is not enabled by server configuration |
| AI_PROVIDER_AUTH_FAILED | 502 | Upstream rejected the server-side credentials or model permission |
| AI_PROVIDER_RATE_LIMITED | 429 | Upstream provider rate-limited the request |
| AI_PROVIDER_UNAVAILABLE | 502 | Upstream provider returned a server error |
| AI_PROVIDER_REJECTED | 502 | Upstream rejected the request (for example, unsupported parameters or invalid model) |
| AI_PROVIDER_UNREACHABLE | 502 | NOVA could not connect to the upstream provider |
| AI_TIMEOUT | 504 | Upstream request exceeded the configured timeout |
| AI_REQUEST_CANCELLED | 499 | The client cancelled or disconnected during generation |
| AI_EMPTY_RESPONSE | 502 | Provider completed without usable text |
| AI_INVALID_RESPONSE | 502 | Provider returned malformed JSON |
| AI_INVALID_STREAM | 502 | Provider returned malformed SSE data |
| AI_PROVIDER_STREAM_ERROR | 502 | Provider sent an error event inside an SSE response |
| AI_PROVIDER_ERROR | 502 | Legacy fallback for an unclassified provider error |
| AI_INPUT_TOO_LARGE | 413 | Current message exceeds the character ceiling or model input-token allowance |
| AI_RATE_LIMITED | 429 | Authenticated user's generation frequency limit was reached |
| AI_GENERATION_IN_PROGRESS | 409 | Another generation is already active for this user |

Provider HTTP statuses, network failures, timeouts, JSON/SSE parse errors, empty completions, and cancellation are normalized to stable NOVA error codes. Raw upstream bodies, credential values, and private provider details are not returned. When a request reaches a configured provider, JSON errors include a `requestId`; streaming clients receive the same reference in `message_start` and terminal events.


## Usage records

Every model generation that reaches the Provider layer creates a server-side usage record. This covers the legacy JSON chat route, streaming chat, editing/regenerating a user turn, and retrying a failed response.

Records contain a random request ID, account ID, provider/model ID, operation, lifecycle status, normalized error code, elapsed milliseconds, provider-reported input/output/total token counts when supplied, and timestamps. NOVA does not save prompts or assistant content in the usage table, and it never stores provider API keys or base URLs there.

Token fields remain `null` when the Provider does not return usage metadata. NOVA does not infer exact tokens from character counts, and it does not calculate monetary cost without trusted provider pricing and usage data.

Administrators can read the latest records and aggregate totals through `GET /api/v1/admin/usage?limit=50` (administrator session required; limit is clamped to 1–100). The aggregate labels explicitly refer to Provider-reported token values. Account JSON export includes the account's own usage history; deleting an account deletes its usage records through the user foreign-key cascade.

## Generation limits

- Each authenticated user is limited to 6 generation requests per minute across the streaming and legacy message endpoints.
- The streaming endpoint allows one active generation per user at a time. A second concurrent request returns HTTP 409 AI_GENERATION_IN_PROGRESS.
- These guards use the process-local in-memory store, appropriate for the current single-instance SQLite deployment. Multi-instance deployment requires a shared limiter/lock store before horizontal scaling.

## Current limitations

- The current native adapter targets OpenAI-compatible Chat Completions. Native Anthropic protocol support, browser-login/OAuth providers, automatic model discovery, provider failover, tools and attachments remain unimplemented.
- Provider health and explicit model context-window discovery are read-only, on-demand probes; they are not continuous monitoring or a guarantee that a provider's limits will remain unchanged.
- Context budgets use local estimates or conservative byte upper bounds rather than the upstream tokenizer implementation for every third-party model. Cost/pricing estimates and hard account spending budgets remain unimplemented.
- Persistent request Usage records capture lifecycle, duration, provider/model, normalized failure code, and upstream-reported token counts when supplied. Per-user request throttling and one-active-generation controls use a process-local store.
- The old non-streaming JSON message endpoint remains available for compatibility; the Chat UI uses the streaming endpoint. User-message edits and assistant regeneration use the versioned PUT streaming endpoint and commit the replacement branch only after success. Assistant answer versions can be listed and restored with the conversation version endpoints.

## Research

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/research | List published Research articles (public) |
| GET | /api/v1/research/:slug | Read one published article (public) |
| POST | /api/v1/research/search | Run a real web search (authenticated, 8 requests/user/minute) |
| POST | /api/v1/research | Create an article (administrator only) |
| PUT | /api/v1/research/:id | Update an article (administrator only) |
| DELETE | /api/v1/research/:id | Delete an article (administrator only) |

`POST /api/v1/research/search` body: `{ "query": "2-300 chars", "count": 1-10 }`. Responses are `Cache-Control: no-store` and contain `query`, `provider`, `retrievedAt`, `moreResultsAvailable` and `sources[]` where each source has `id`, `title`, `url`, `domain`, `snippet`, `publishedAt`, `engines` and `provider`.

Search requires server-side configuration: `RESEARCH_SEARCH_PROVIDER=searxng` plus `RESEARCH_SEARCH_URL`, or `RESEARCH_SEARCH_PROVIDER=brave` plus `BRAVE_SEARCH_API_KEY`. With no provider the endpoint returns 503 `RESEARCH_SEARCH_NOT_CONFIGURED`; NOVA never returns sample or fabricated results. Only HTTP/HTTPS URLs without embedded credentials are returned; duplicates and untitled results are dropped. Provider errors are normalized:

| Code | HTTP status | Meaning |
|---|---:|---|
| RESEARCH_SEARCH_NOT_CONFIGURED | 503 | No search provider is configured on the server |
| RESEARCH_SEARCH_CONFIG_INVALID | 503 | The configured base URL is not a valid HTTPS base URL |
| RESEARCH_SEARCH_TIMEOUT | 504 | The search provider exceeded `RESEARCH_SEARCH_TIMEOUT_MS` |
| RESEARCH_SEARCH_NETWORK_ERROR | 502 | The search provider could not be reached |
| RESEARCH_SEARCH_UPSTREAM_AUTH_FAILED | 502 | Provider rejected the credential or has JSON output disabled |
| RESEARCH_SEARCH_UPSTREAM_RATE_LIMITED | 429 | Provider rate-limited the request |
| RESEARCH_SEARCH_UPSTREAM_UNAVAILABLE | 502 | Provider returned an error status |
| RESEARCH_SEARCH_RESPONSE_TOO_LARGE | 502 | Response exceeded the 1.5 MB read cap |
| RESEARCH_SEARCH_INVALID_RESPONSE | 502 | Provider returned malformed JSON or an unreadable body |
| RESEARCH_SEARCH_RATE_LIMITED | 429 | The authenticated user exceeded 8 searches/minute |

Search results are retrieval material, not verified facts. The client lets users pick sources, attach notes, and save a Markdown record with retrieval time, snippets, URLs and citation indexes into their own Documents.

## Administration: audit and monitoring

Both endpoints require an authenticated administrator session and are `Cache-Control: no-store`.

| Method | Path | Purpose |
|---|---|---|
| GET | /api/v1/admin/audit-logs?limit=1-200 | Recent privileged actions (role changes, provider create/update/delete, default model, Research article writes) |
| GET | /api/v1/admin/monitoring | In-process error aggregates plus uptime |

Audit entries contain `id`, `actorUserId`, `actorEmail`, `actorName`, `action`, `targetType`, `targetId`, `metadata` and `createdAt`. Metadata is sanitized before storage: fields whose names look like credentials, tokens, passwords, cookies, encrypted blobs, base URLs or user content are dropped, strings are truncated to 300 characters, and nesting is capped. Audit writes never fail the request path.

`/monitoring` returns `errors.totalErrors`, `errors.codes[]` (`code`, `count`, `lastStatus`, `lastAt`, `routes`), `errors.recent[]` (`requestId`, `code`, `status`, `route`, `at`) and `uptimeSeconds`. Counters are process-local and reset on restart. Every API response carries an `X-Request-Id` header; error responses echo the same value as `requestId`.

## Security headers and origins

- API responses are sent through Helmet with a deny-by-default CSP (`default-src 'none'`, `frame-ancestors 'none'`).
- When the API also serves `client/dist`, `index.html` responses carry the document CSP and SPA deep-link fallback; see `docs/DEPLOYMENT.md`.
- State-changing requests must send `X-Requested-With: NOVA-Web`. Any supplied `Origin` must match `WEB_ORIGIN`; in production a missing `Origin` returns 403 `MISSING_ORIGIN`.

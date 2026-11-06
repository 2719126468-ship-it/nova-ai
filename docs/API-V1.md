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

Returns the server-side model catalog. The response contains providers, models, defaultModelId and contextPolicy. API keys and provider base URLs are never returned. The top-level provider object reports configuration separately from upstream health; configured providers remain health: unknown until a real probe is run. The health endpoint returns ai.status as configured_unverified or not_configured.

### POST /api/v1/models/health

Requires an authenticated session and is limited to 5 checks per user per minute. Body: `{ "modelId": "provider-id:upstream-model-id" }`. The server makes a read-only authenticated GET request to the Provider's `/models` endpoint; it never generates a prompt or spends completion tokens. It returns `healthy` only when the upstream catalog confirms the exact upstream model ID. A provider that does not support `/models`, or returns an unrecognized catalog, remains `unknown` rather than being incorrectly marked unavailable. Authentication failures/server errors report `unavailable`; upstream 429 reports `degraded`. The result is an on-demand observation, not a persisted long-term health guarantee.

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
  "contextLimit": null
}
```

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

The server applies a configurable character budget to message content before sending a prompt upstream. Configure it with `AI_MAX_CONTEXT_CHARS` (default `40000`, allowed range `512`–`200000`). This is a JavaScript string-length budget, **not a token count**. The API reports `contextPolicy.tokenLimit: null` because provider/model token windows are not currently verified. NOVA keeps the newest complete turns that fit and always preserves the current user message. A failed/cancelled turn's unmatched trailing user message is not replayed as conversation history. If the current message alone exceeds the configured budget, the API returns HTTP 413 `AI_INPUT_TOO_LARGE` before calling the provider.

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

A project and conversation can be linked only when both belong to the authenticated user. Cross-account project/conversation combinations return 404. Duplicate links are idempotent. Removing a link does not delete the conversation or its messages; deleting a project removes its link rows through foreign-key cascade. Deleting a conversation also removes its link rows.

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
| message_start | userMessage, assistantMessageId, modelId | The user message and pending assistant message have been persisted |
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
| AI_INPUT_TOO_LARGE | 413 | Current message exceeds the configured character budget |
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

- One OpenAI-compatible provider and one configured model are supported.
- The server does not yet perform active model health checks.
- Context considers up to 30 completed messages and trims older turns to the configured character budget; provider-specific token counting and context-window limits remain pending.
- Persistent request Usage records now capture lifecycle, duration, provider/model, normalized failure code, and upstream-reported token counts when supplied. Tokenizer-based estimates, model pricing/cost accounting, hard account budgets, tools, attachments, and provider failover remain unimplemented. Per-user request throttling and one-active-generation controls use a process-local store.
- The old non-streaming JSON message endpoint remains available for compatibility; the Chat UI uses the streaming endpoint. User-message edits and assistant regeneration use the versioned PUT streaming endpoint and commit the replacement branch only after success. Assistant answer versions can be listed and restored with the conversation version endpoints.

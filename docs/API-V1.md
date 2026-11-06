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

Returns the server-side model catalog. API keys are never returned. The top-level provider object reports configuration separately from upstream health; configured providers remain health: unknown until a real probe is implemented. The health endpoint also returns ai.status as configured_unverified or not_configured.

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

status: unknown means that the model is configured but has not been actively verified. Do not present this state as connected, healthy, or available. The initial release exposes one environment-configured model; it does not yet provide a multi-provider registry or live health probes.

Malformed AI_PROVIDERS_JSON disables the multi-provider registry and reports AI_PROVIDERS_JSON_INVALID in the catalog; a non-empty invalid JSON setting does not silently fall back to legacy credentials.

## Context budget

The server applies a configurable character budget to message content before sending a prompt upstream. Configure it with `AI_MAX_CONTEXT_CHARS` (default `40000`, allowed range `512`–`200000`). This is a JavaScript string-length budget, **not a token count**. The API reports `contextPolicy.tokenLimit: null` because provider/model token windows are not currently verified. NOVA keeps the newest complete turns that fit and always preserves the current user message. A failed/cancelled turn's unmatched trailing user message is not replayed as conversation history. If the current message alone exceeds the configured budget, the API returns HTTP 413 `AI_INPUT_TOO_LARGE` before calling the provider.

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
| AI_PROVIDER_NOT_CONFIGURED | 503 | Required server-side AI environment variables are missing |
| MODEL_NOT_FOUND | 404 | Requested model is not enabled by server configuration |
| AI_PROVIDER_RATE_LIMITED | 429 | Upstream provider rate-limited the request |
| AI_PROVIDER_UNAVAILABLE | 502 | Upstream provider returned a server error |
| AI_PROVIDER_ERROR | 502 | Upstream provider rejected the request |
| AI_TIMEOUT | 504 | Upstream request exceeded the configured timeout |
| AI_EMPTY_RESPONSE | 502 | Provider completed without usable text |
| AI_INVALID_STREAM | 502 | Provider returned malformed SSE data |
| AI_INPUT_TOO_LARGE | 413 | Current message exceeds the configured character budget |
| AI_RATE_LIMITED | 429 | Authenticated user's generation frequency limit was reached |
| AI_GENERATION_IN_PROGRESS | 409 | Another generation is already active for this user |

Provider error messages are normalized rather than returning raw upstream response bodies. API credentials remain server-side.

## Generation limits

- Each authenticated user is limited to 6 generation requests per minute across the streaming and legacy message endpoints.
- The streaming endpoint allows one active generation per user at a time. A second concurrent request returns HTTP 409 AI_GENERATION_IN_PROGRESS.
- These guards use the process-local in-memory store, appropriate for the current single-instance SQLite deployment. Multi-instance deployment requires a shared limiter/lock store before horizontal scaling.

## Current limitations

- One OpenAI-compatible provider and one configured model are supported.
- The server does not yet perform active model health checks.
- Context considers up to 30 completed messages and trims older turns to the configured character budget; provider-specific token counting and context-window limits remain pending.
- Usage metering and provider token/quota accounting, tools, attachments, and provider failover are not implemented. Per-user request throttling and one-active-generation controls are implemented with a process-local store.
- The old non-streaming JSON message endpoint remains available for compatibility; the Chat UI uses the streaming endpoint. User-message edits and assistant regeneration use the versioned PUT streaming endpoint and commit the replacement branch only after success.

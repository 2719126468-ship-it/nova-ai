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

Returns the server-side model catalog. API keys are never returned.

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

### SSE events

Each event uses the standard event: and data: framing.

| Event | Payload | Meaning |
|---|---|---|
| message_start | userMessage, assistantMessageId, modelId | The user message and pending assistant message have been persisted |
| message_delta | messageId, delta | A new text fragment is available |
| message_complete | assistantMessage | The final assistant text has been saved |
| message_error | messageId, code, message | Generation failed; any partial text is retained |
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

Provider error messages are normalized rather than returning raw upstream response bodies. API credentials remain server-side.

## Current limitations

- One OpenAI-compatible provider and one configured model are supported.
- The server does not yet perform active model health checks.
- Context includes up to 30 completed messages; token-budget-aware truncation is still pending.
- Usage metering, per-user AI quotas, concurrent generation limits, tools, attachments, and provider failover are not implemented.
- The old non-streaming JSON message endpoint remains available for compatibility; the Chat UI is being migrated to the streaming endpoint.

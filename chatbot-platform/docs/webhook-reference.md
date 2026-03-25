# Webhook API Reference

Complete reference for all n8n webhook endpoints.

## Base URL

```
https://api.chatbot-platform.com/api/v1/n8n
```

## Authentication

All requests must include the webhook secret:

```http
X-Webhook-Secret: your-secret-here
# OR
Authorization: Bearer your-secret-here
```

## Endpoints

### POST /webhook/inbound

Receive messages/actions from n8n to the chatbot platform.

#### Request

```http
POST /api/v1/n8n/webhook/inbound
Content-Type: application/json
X-Webhook-Secret: your-secret

{
  "action": "message.send",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "tenantId": "550e8400-e29b-41d4-a716-446655440001",
  "payload": {
    "type": "text",
    "content": "Hello! How can I help you today?",
    "quickReplies": ["Option 1", "Option 2"]
  },
  "delay": 0,
  "priority": "normal"
}
```

#### Actions

| Action | Description |
|--------|-------------|
| `message.send` | Send a message to the user |
| `message.edit` | Edit an existing message |
| `message.delete` | Delete a message |
| `typing.start` | Show typing indicator |
| `typing.stop` | Hide typing indicator |
| `handsoff.trigger` | Escalate to human agent |
| `handsoff.release` | Release from human agent |
| `file.request` | Request file upload from user |
| `session.clear` | Clear session context |
| `session.transfer` | Transfer to another queue |
| `user.update` | Update user context |

#### Response

**Success (200):**
```json
{
  "success": true,
  "messageId": "msg_1234567890"
}
```

**Error (400):**
```json
{
  "success": false,
  "error": "Invalid message format",
  "details": ["payload.content is required"]
}
```

**Error (401):**
```json
{
  "success": false,
  "error": "Unauthorized: Invalid or missing webhook secret"
}
```

**Error (429):**
```json
{
  "success": false,
  "error": "Too many requests, please try again later",
  "retryAfter": 60
}
```

---

### GET /webhook/health

Health check endpoint for monitoring.

#### Request

```http
GET /api/v1/n8n/webhook/health
```

#### Response

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00Z",
  "circuitBreaker": {
    "state": "CLOSED",
    "failures": 0
  },
  "services": {
    "webhook": true,
    "circuitBreaker": true,
    "retry": true,
    "fallback": true
  }
}
```

---

### GET /webhook/circuit-status

Get current circuit breaker status.

#### Request

```http
GET /api/v1/n8n/webhook/circuit-status
Authorization: Bearer admin-token
```

#### Response

```json
{
  "state": "CLOSED",
  "failures": 0,
  "successCount": 0,
  "lastFailureTime": null,
  "lastSuccessTime": "2024-01-15T10:30:00Z",
  "nextAttemptTime": null,
  "stats": {
    "totalRequests": 150,
    "successfulRequests": 145,
    "failedRequests": 5,
    "rejectedRequests": 0,
    "stateChanges": 2,
    "averageResponseTime": 245
  }
}
```

#### States

| State | Description |
|-------|-------------|
| `CLOSED` | Normal operation, requests pass through |
| `OPEN` | Failure threshold reached, requests rejected |
| `HALF_OPEN` | Testing if service has recovered |

---

### POST /webhook/circuit-reset

Manually reset the circuit breaker.

#### Request

```http
POST /api/v1/n8n/webhook/circuit-reset
Authorization: Bearer admin-token
```

#### Response

```json
{
  "success": true,
  "message": "Circuit breaker reset successfully",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

---

### GET /webhook/queue-status

Get message queue status.

#### Request

```http
GET /api/v1/n8n/webhook/queue-status
Authorization: Bearer admin-token
```

#### Response

```json
{
  "success": true,
  "queue": {
    "waiting": 5,
    "active": 2,
    "completed": 150,
    "failed": 3,
    "delayed": 1,
    "paused": 0
  }
}
```

---

### POST /webhook/retry/:messageId

Retry a specific failed message.

#### Request

```http
POST /api/v1/n8n/webhook/retry/msg_1234567890
Authorization: Bearer admin-token
```

#### Response

**Success (200):**
```json
{
  "success": true,
  "message": "Message retry initiated",
  "messageId": "msg_1234567890"
}
```

**Error (404):**
```json
{
  "success": false,
  "error": "Message not found in queue",
  "messageId": "msg_1234567890"
}
```

---

### POST /webhook/register

Register a new webhook URL for receiving events.

#### Request

```http
POST /api/v1/n8n/webhook/register
Content-Type: application/json
Authorization: Bearer admin-token

{
  "url": "https://n8n.example.com/webhook/chatbot",
  "events": ["message.received", "session.started"],
  "secret": "webhook-verification-secret",
  "headers": {
    "X-Custom-Header": "value"
  }
}
```

#### Events

| Event | Description |
|-------|-------------|
| `message.received` | User sent a message |
| `message.sent` | Message sent to user |
| `session.started` | New chat session started |
| `session.ended` | Chat session ended |
| `user.typing` | User typing indicator |
| `file.uploaded` | User uploaded a file |
| `handsoff.requested` | Human handoff requested |
| `handsoff.accepted` | Human agent accepted |
| `handsoff.released` | Human handoff released |

#### Response

```json
{
  "success": true,
  "message": "Webhook registered successfully",
  "webhookId": "wh_1234567890"
}
```

---

### DELETE /webhook/unregister/:webhookId

Unregister a webhook.

#### Request

```http
DELETE /api/v1/n8n/webhook/unregister/wh_1234567890
Authorization: Bearer admin-token
```

#### Response

```json
{
  "success": true,
  "message": "Webhook wh_1234567890 unregistered successfully"
}
```

---

### GET /webhook/registered

List all registered webhooks.

#### Request

```http
GET /api/v1/n8n/webhook/registered
Authorization: Bearer admin-token
```

#### Response

```json
{
  "success": true,
  "webhooks": [
    {
      "id": "wh_1234567890",
      "url": "https://n8n.example.com/webhook/chatbot",
      "events": ["message.received", "session.started"],
      "active": true,
      "createdAt": "2024-01-15T10:00:00Z"
    }
  ]
}
```

---

### GET /webhook/events

Get list of available webhook events.

#### Request

```http
GET /api/v1/n8n/webhook/events
```

#### Response

```json
{
  "success": true,
  "events": [
    {
      "name": "message.received",
      "description": "Triggered when a user sends a message",
      "payload": {
        "event": "message.received",
        "sessionId": "uuid",
        "payload": { "type": "text", "content": "Hello" }
      }
    }
  ]
}
```

## Outbound Webhooks (Platform → n8n)

The platform sends webhooks to n8n when events occur.

### Message Received Event

```http
POST https://n8n.example.com/webhook/chatbot
Content-Type: application/json
X-Webhook-ID: wh_1234567890
X-Tenant-ID: tenant_123
X-Session-ID: session_456
X-Event-Type: message.received
X-Timestamp: 2024-01-15T10:30:00Z
X-Webhook-Signature: sha256=abc123...

{
  "event": "message.received",
  "tenantId": "550e8400-e29b-41d4-a716-446655440001",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2024-01-15T10:30:00Z",
  "payload": {
    "type": "text",
    "content": "Hello, I need help!"
  },
  "user": {
    "anonymousId": "550e8400-e29b-41d4-a716-446655440002",
    "browser": "Mozilla/5.0...",
    "ip": "a1b2c3d4e5f6...",
    "geo": {
      "country": "United States",
      "countryCode": "US"
    }
  },
  "context": {
    "previousMessages": [],
    "pageUrl": "https://example.com/pricing"
  }
}
```

### Expected Response

n8n should respond within 5 seconds:

```json
{
  "success": true,
  "actions": [
    {
      "action": "message.send",
      "sessionId": "550e8400-e29b-41d4-a716-446655440000",
      "payload": {
        "type": "text",
        "content": "Hi! How can I help you today?"
      }
    }
  ]
}
```

## Error Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad Request - Invalid message format |
| 401 | Unauthorized - Invalid secret |
| 403 | Forbidden - IP not allowed |
| 404 | Not Found - Resource doesn't exist |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |
| 503 | Service Unavailable - Circuit breaker open |

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `/webhook/inbound` | 100 requests/minute |
| `/webhook/health` | No limit |
| Admin endpoints | 60 requests/minute |

## Webhook Signature Verification

To verify webhook authenticity:

```typescript
import crypto from 'crypto';

function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  
  return crypto.timingSafeEqual(
    Buffer.from(signature.replace('sha256=', '')),
    Buffer.from(expectedSignature)
  );
}

// Usage
const isValid = verifyWebhookSignature(
  JSON.stringify(req.body),
  req.headers['x-webhook-signature'] as string,
  webhookSecret
);
```

## Testing Webhooks

### Using cURL

```bash
# Test inbound webhook
curl -X POST http://localhost:3000/api/v1/n8n/webhook/inbound \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: your-secret" \
  -d '{
    "action": "message.send",
    "sessionId": "test-session-123",
    "payload": {
      "type": "text",
      "content": "Test message"
    }
  }'

# Test health endpoint
curl http://localhost:3000/api/v1/n8n/webhook/health

# Test circuit status
curl http://localhost:3000/api/v1/n8n/webhook/circuit-status \
  -H "Authorization: Bearer admin-token"
```

### Using Postman

1. Import the collection from `/docs/postman/n8n-webhooks.json`
2. Set environment variables:
   - `baseUrl`: `http://localhost:3000`
   - `webhookSecret`: `your-secret`
   - `adminToken`: `admin-token`

## SDK Examples

### JavaScript/TypeScript

```typescript
import { N8nClient } from '@chatbot-platform/sdk';

const client = new N8nClient({
  baseUrl: 'https://api.chatbot-platform.com',
  secret: 'your-webhook-secret'
});

// Send message
await client.sendMessage({
  sessionId: 'session-123',
  payload: {
    type: 'text',
    content: 'Hello!'
  }
});

// Trigger handoff
await client.triggerHandoff({
  sessionId: 'session-123',
  reason: 'Customer request'
});
```

### Python

```python
import requests

headers = {
    'Content-Type': 'application/json',
    'X-Webhook-Secret': 'your-secret'
}

response = requests.post(
    'https://api.chatbot-platform.com/api/v1/n8n/webhook/inbound',
    headers=headers,
    json={
        'action': 'message.send',
        'sessionId': 'session-123',
        'payload': {
            'type': 'text',
            'content': 'Hello!'
        }
    }
)

print(response.json())
```

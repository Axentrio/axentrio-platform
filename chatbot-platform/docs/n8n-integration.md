# n8n Integration Guide

Complete integration guide for connecting the white-label chatbot platform with n8n workflows.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Message Flow](#message-flow)
- [Security](#security)
- [Monitoring](#monitoring)
- [Best Practices](#best-practices)

## Overview

The n8n integration module provides a robust, production-ready connection between the chatbot platform and n8n workflows. It handles:

- **Inbound webhooks**: Messages from n8n to the platform
- **Outbound webhooks**: Messages from the platform to n8n
- **Circuit breaker pattern**: Automatic failover when n8n is unavailable
- **Retry mechanism**: Exponential backoff for failed messages
- **Fallback responses**: Graceful degradation when n8n fails

### Key Features

| Feature | Description |
|---------|-------------|
| 5s Timeout | Webhook requests timeout after 5 seconds |
| 3x Retry | Failed messages retry 3 times with exponential backoff |
| Circuit Breaker | Opens after 5 consecutive failures |
| 99.9% Delivery | Guaranteed message delivery with queueing |
| Auto Handoff | Automatic human escalation on failures |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Chatbot Platform                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  Webhook    │  │  Outbound   │  │    Circuit Breaker      │  │
│  │  Controller │  │  Service    │  │    (5 failures = OPEN)  │  │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────────────┘  │
│         │                │                                       │
│  ┌──────▼────────────────▼──────┐  ┌─────────────────────────┐  │
│  │        Retry Service          │  │    Fallback Service     │  │
│  │   (Redis Queue - Bull)        │  │  (Graceful degradation) │  │
│  └──────────────┬────────────────┘  └─────────────────────────┘  │
│                 │                                                 │
│  ┌──────────────▼────────────────┐                               │
│  │        Redis Queue            │                               │
│  │   (Failed message storage)    │                               │
│  └───────────────────────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP/HTTPS
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         n8n                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   Webhook   │  │  Process    │  │     Response Node       │  │
│  │   Trigger   │  │  Logic      │  │                         │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install Dependencies

```bash
npm install axios bull ajv @types/json-schema
```

### 2. Initialize the Module

```typescript
import { createN8nModule } from './api/src/n8n';

const n8nModule = createN8nModule({
  redisUrl: 'redis://localhost:6379',
  
  circuitBreaker: {
    failureThreshold: 5,
    successThreshold: 3,
    timeout: 30000,
  },
  
  retry: {
    maxRetries: 3,
    initialDelay: 1000,
    backoffMultiplier: 2,
    maxDelay: 30000,
  },
  
  webhook: {
    secret: 'your-webhook-secret',
    timeout: 5000,
  },
  
  fallback: {
    defaultMessage: "I'm having trouble connecting. Please try again.",
    handoffOnFailure: true,
    enableQuickReplies: true,
  },
  
  services: {
    chatSessionService,
    messageService,
    handoffService,
    userService,
    eventEmitter,
    metricsService,
  },
});

// Register routes
app.use('/api/v1/n8n', n8nModule.router);
```

### 3. Configure n8n Webhook

1. Create a new workflow in n8n
2. Add a "Webhook" trigger node
3. Set HTTP Method to POST
4. Copy the webhook URL
5. Configure it in the chatbot platform

### 4. Test the Integration

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
      "content": "Hello from n8n!"
    }
  }'
```

## Configuration

### Circuit Breaker Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `failureThreshold` | 5 | Failures before opening circuit |
| `successThreshold` | 3 | Successes in HALF_OPEN to close |
| `timeout` | 30000 | ms before attempting recovery |
| `monitoringPeriod` | 60000 | Time window for counting failures |

### Retry Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `maxRetries` | 3 | Maximum retry attempts |
| `initialDelay` | 1000 | Initial retry delay (ms) |
| `backoffMultiplier` | 2 | Exponential backoff multiplier |
| `maxDelay` | 30000 | Maximum retry delay (ms) |

### Webhook Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `timeout` | 5000 | Request timeout (ms) |
| `secret` | - | Webhook verification secret |
| `rateLimitWindowMs` | 60000 | Rate limit window (ms) |
| `rateLimitMax` | 100 | Max requests per window |

## Message Flow

### Outbound Flow (Platform → n8n)

```
1. User sends message
2. Platform builds outbound message with context
3. Circuit breaker check
4. Send HTTP POST to n8n webhook
5. If success: Return response
6. If failure: Queue for retry
7. If circuit open: Return fallback
```

### Inbound Flow (n8n → Platform)

```
1. n8n sends POST to platform webhook
2. Validate message schema
3. Verify webhook secret
4. Process action (message.send, handsoff.trigger, etc.)
5. Return success response
```

## Security

### Webhook Secret Verification

```typescript
// HMAC signature verification
const signature = crypto
  .createHmac('sha256', secret)
  .update(JSON.stringify(payload))
  .digest('hex');

// Compare with header
const providedSignature = req.headers['x-webhook-signature'];
```

### IP Whitelisting

```typescript
const allowedIps = ['1.2.3.4', '5.6.7.8'];
if (!allowedIps.includes(req.ip)) {
  return res.status(403).json({ error: 'IP not allowed' });
}
```

### Rate Limiting

```typescript
const limiter = rateLimit({
  windowMs: 60000,
  max: 100,
  message: 'Too many requests'
});
```

## Monitoring

### Metrics to Track

| Metric | Description |
|--------|-------------|
| `n8n_webhook_success` | Successful webhook calls |
| `n8n_webhook_errors` | Failed webhook calls |
| `n8n_webhook_duration` | Response time histogram |
| `n8n_message_queued` | Messages queued for retry |
| `n8n_retry_success` | Successful retries |
| `n8n_retry_failed` | Failed retries |
| `n8n_circuit_state` | Current circuit state |

### Health Check Endpoint

```bash
GET /api/v1/n8n/webhook/health
```

Response:
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

### Circuit Status Endpoint

```bash
GET /api/v1/n8n/webhook/circuit-status
```

Response:
```json
{
  "state": "CLOSED",
  "failures": 0,
  "successCount": 0,
  "stats": {
    "totalRequests": 150,
    "successfulRequests": 145,
    "failedRequests": 5,
    "rejectedRequests": 0
  }
}
```

## Best Practices

### 1. Always Use Circuit Breaker

```typescript
// Good
const result = await circuitBreaker.execute(
  () => sendWebhookRequest(config, message),
  () => fallbackService.getFallbackResponse(message)
);
```

### 2. Implement Proper Timeouts

```typescript
// 5 second timeout for webhook requests
const response = await axios.post(url, payload, {
  timeout: 5000,
});
```

### 3. Validate All Messages

```typescript
const validation = validateJsonSchema(message, schema);
if (!validation.valid) {
  throw new Error(`Validation failed: ${validation.errors}`);
}
```

### 4. Log Everything

```typescript
logger.info('Webhook request', {
  sessionId,
  event,
  duration,
  success: response.status === 200
});
```

### 5. Handle Errors Gracefully

```typescript
try {
  await sendToWebhook(config, message);
} catch (error) {
  // Queue for retry instead of failing
  await retryService.queueMessage({
    message,
    config,
    error: error.message
  });
}
```

### 6. Monitor Queue Depth

```typescript
const status = await retryService.getQueueStatus();
if (status.waiting > 100) {
  alert('High queue depth - check n8n connectivity');
}
```

## Troubleshooting

### Circuit Breaker Keeps Opening

1. Check n8n webhook URL is correct
2. Verify n8n is running and accessible
3. Check network connectivity
4. Review n8n workflow logs

### Messages Not Being Processed

1. Check Redis connection
2. Verify queue is not paused
3. Check for stuck jobs
4. Review worker process logs

### High Latency

1. Check n8n server resources
2. Optimize n8n workflow
3. Consider caching responses
4. Use CDN for static assets

## API Reference

See [webhook-reference.md](./webhook-reference.md) for complete API documentation.

## Message Format

See [message-format.md](./message-format.md) for message schema details.

## Support

For issues and questions:
- Check [troubleshooting.md](./troubleshooting.md)
- Review n8n workflow examples in `/docs/n8n-workflows/`
- Contact support@chatbot-platform.com

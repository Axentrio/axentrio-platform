# Troubleshooting Guide

Common issues and solutions for n8n integration.

## Table of Contents

- [Circuit Breaker Issues](#circuit-breaker-issues)
- [Webhook Failures](#webhook-failures)
- [Queue Problems](#queue-problems)
- [Performance Issues](#performance-issues)
- [Authentication Errors](#authentication-errors)
- [Message Delivery Issues](#message-delivery-issues)

## Circuit Breaker Issues

### Circuit Breaker Keeps Opening

**Symptoms:**
- All requests fail with "Circuit breaker is OPEN"
- High failure rate in metrics

**Causes & Solutions:**

1. **n8n is down or unreachable**
   ```bash
   # Check n8n health
   curl https://your-n8n-instance.com/healthz
   
   # Check network connectivity
   ping your-n8n-instance.com
   ```

2. **Incorrect webhook URL**
   ```bash
   # Verify webhook URL
   curl -I https://your-n8n.com/webhook/chatbot
   ```

3. **n8n workflow is disabled**
   - Log into n8n
   - Check if workflow is active
   - Enable if needed

4. **n8n workflow has errors**
   - Check n8n execution logs
   - Look for node errors
   - Fix workflow issues

**Manual Reset:**
```bash
curl -X POST https://api.chatbot-platform.com/api/v1/n8n/webhook/circuit-reset \
  -H "Authorization: Bearer admin-token"
```

### Circuit Breaker Not Opening When It Should

**Symptoms:**
- Slow responses
- Timeouts not triggering circuit breaker

**Solution:**
```typescript
// Check failure threshold configuration
const circuitBreaker = new CircuitBreaker({
  failureThreshold: 5,  // May need to lower this
  timeout: 30000,
});
```

## Webhook Failures

### 401 Unauthorized

**Symptoms:**
```json
{
  "success": false,
  "error": "Unauthorized: Invalid or missing webhook secret"
}
```

**Solutions:**

1. **Verify secret is correct**
   ```bash
   # Check configured secret
   echo $WEBHOOK_SECRET
   
   # Test with correct secret
   curl -X POST https://api.chatbot-platform.com/api/v1/n8n/webhook/inbound \
     -H "X-Webhook-Secret: correct-secret"
   ```

2. **Check header name**
   - Use `X-Webhook-Secret` or `Authorization: Bearer`
   - Case-sensitive header names

3. **Secret not configured**
   ```typescript
   // Add secret to configuration
   const n8nModule = createN8nModule({
     webhook: {
       secret: process.env.WEBHOOK_SECRET,
     },
   });
   ```

### 400 Bad Request

**Symptoms:**
```json
{
  "success": false,
  "error": "Bad Request: Invalid message format",
  "details": [...]
}
```

**Solutions:**

1. **Validate JSON schema**
   ```bash
   # Test with valid payload
   curl -X POST https://api.chatbot-platform.com/api/v1/n8n/webhook/inbound \
     -H "Content-Type: application/json" \
     -d '{
       "action": "message.send",
       "sessionId": "550e8400-e29b-41d4-a716-446655440000",
       "payload": {
         "type": "text",
         "content": "Hello"
       }
     }'
   ```

2. **Check required fields**
   - `action` is required
   - `sessionId` must be valid UUID
   - `payload` must be object

3. **Validate session exists**
   ```bash
   # Check if session exists
   curl https://api.chatbot-platform.com/api/v1/sessions/{sessionId}
   ```

### 429 Too Many Requests

**Symptoms:**
```json
{
  "success": false,
  "error": "Too many requests, please try again later",
  "retryAfter": 60
}
```

**Solutions:**

1. **Implement rate limiting in n8n**
   - Add delay between requests
   - Batch multiple actions

2. **Increase rate limit**
   ```typescript
   const router = createWebhookRouter({
     rateLimitWindowMs: 60000,
     rateLimitMax: 200,  // Increase from 100
   });
   ```

3. **Check for retry loops**
   - Ensure n8n doesn't retry on 429
   - Use exponential backoff

### 500 Internal Server Error

**Symptoms:**
```json
{
  "success": false,
  "error": "Internal Server Error: Failed to process webhook"
}
```

**Solutions:**

1. **Check server logs**
   ```bash
   # View application logs
   docker logs chatbot-api
   
   # View specific error
   grep "Error" /var/log/chatbot/app.log
   ```

2. **Verify database connection**
   ```bash
   # Test database
   psql -h localhost -U chatbot -d chatbot_db -c "SELECT 1"
   ```

3. **Check Redis connection**
   ```bash
   # Test Redis
   redis-cli ping
   ```

## Queue Problems

### Messages Stuck in Queue

**Symptoms:**
- Queue depth keeps increasing
- Messages not being processed

**Solutions:**

1. **Check queue status**
   ```bash
   curl https://api.chatbot-platform.com/api/v1/n8n/webhook/queue-status \
     -H "Authorization: Bearer admin-token"
   ```

2. **Resume paused queue**
   ```typescript
   await retryService.resume();
   ```

3. **Check Redis memory**
   ```bash
   # Check Redis memory usage
   redis-cli info memory
   
   # Check for memory issues
   redis-cli --bigkeys
   ```

4. **Restart queue processor**
   ```bash
   # Restart worker
   pm2 restart chatbot-worker
   ```

### Queue Not Processing

**Symptoms:**
- Queue has waiting jobs
- No active jobs

**Solutions:**

1. **Check worker is running**
   ```bash
   # Check process
   pm2 status
   
   # Check worker logs
   pm2 logs chatbot-worker
   ```

2. **Verify Redis connection**
   ```typescript
   // Test connection
   await retryService.initialize();
   ```

3. **Check for stuck jobs**
   ```typescript
   const stuckJobs = await retryService.getFailedJobs();
   console.log(`Found ${stuckJobs.length} stuck jobs`);
   ```

### Redis Connection Errors

**Symptoms:**
```
Error: Redis connection to localhost:6379 failed
```

**Solutions:**

1. **Verify Redis is running**
   ```bash
   # Check Redis status
   systemctl status redis
   
   # Start Redis
   sudo systemctl start redis
   ```

2. **Check Redis URL**
   ```typescript
   // Verify connection string
   const retryService = new RetryService({
     redisUrl: 'redis://localhost:6379',  // Check this
   });
   ```

3. **Check firewall rules**
   ```bash
   # Allow Redis port
   sudo ufw allow 6379
   ```

## Performance Issues

### High Response Times

**Symptoms:**
- Average response time > 5 seconds
- Timeouts occurring

**Solutions:**

1. **Monitor n8n performance**
   ```bash
   # Check n8n resources
   docker stats n8n
   
   # Check n8n logs
   docker logs n8n --tail 100
   ```

2. **Optimize n8n workflow**
   - Reduce number of nodes
   - Use efficient queries
   - Add caching

3. **Increase timeout**
   ```typescript
   const outboundService = new OutboundService({
     defaultTimeout: 10000,  // Increase from 5000
   });
   ```

4. **Enable response caching**
   ```typescript
   // Cache common responses
   const cache = new Map();
   
   async function getCachedResponse(key: string) {
     if (cache.has(key)) {
       return cache.get(key);
     }
     const response = await fetchResponse(key);
     cache.set(key, response);
     return response;
   }
   ```

### Memory Leaks

**Symptoms:**
- Memory usage keeps growing
- Application crashes

**Solutions:**

1. **Monitor memory usage**
   ```bash
   # Check Node.js memory
   node --inspect app.js
   
   # Use heap dump
   require('heapdump').writeSnapshot();
   ```

2. **Clear old queue data**
   ```typescript
   // Clean old jobs daily
   setInterval(async () => {
     await retryService.cleanOldJobs(24 * 60 * 60 * 1000);
   }, 24 * 60 * 60 * 1000);
   ```

3. **Limit queue retention**
   ```typescript
   const queue = new Queue('retries', {
     defaultJobOptions: {
       removeOnComplete: 100,
       removeOnFail: 50,
     },
   });
   ```

## Authentication Errors

### Invalid Webhook Signature

**Symptoms:**
- Signature verification fails
- Requests rejected

**Solutions:**

1. **Verify signature generation**
   ```typescript
   // Correct way to generate signature
   const signature = crypto
     .createHmac('sha256', secret)
     .update(JSON.stringify(payload))
     .digest('hex');
   ```

2. **Check signature format**
   ```http
   X-Webhook-Signature: sha256=abc123...
   ```

3. **Use timing-safe comparison**
   ```typescript
   const isValid = crypto.timingSafeEqual(
     Buffer.from(providedSignature.replace('sha256=', '')),
     Buffer.from(expectedSignature)
   );
   ```

### IP Whitelist Issues

**Symptoms:**
```json
{
  "success": false,
  "error": "IP not allowed"
}
```

**Solutions:**

1. **Check client IP**
   ```bash
   # Get your IP
   curl ifconfig.me
   ```

2. **Update whitelist**
   ```typescript
   const allowedIps = [
     '1.2.3.4',
     '5.6.7.8',
     // Add your IP
   ];
   ```

## Message Delivery Issues

### Messages Not Reaching Users

**Symptoms:**
- n8n returns success
- User doesn't see message

**Solutions:**

1. **Check session is active**
   ```bash
   curl https://api.chatbot-platform.com/api/v1/sessions/{sessionId}
   ```

2. **Verify WebSocket connection**
   ```javascript
   // Check browser console
   console.log(socket.connected);  // Should be true
   ```

3. **Check message format**
   ```json
   {
     "action": "message.send",
     "sessionId": "valid-session-id",
     "payload": {
       "type": "text",
       "content": "Hello"  // Required field
     }
   }
   ```

### Duplicate Messages

**Symptoms:**
- Users receive same message multiple times

**Solutions:**

1. **Implement idempotency**
   ```typescript
   // Use message ID for deduplication
   const messageId = `msg_${sessionId}_${timestamp}`;
   ```

2. **Check for retry loops**
   ```typescript
   // Track processed message IDs
   const processedMessages = new Set();
   
   if (processedMessages.has(messageId)) {
     return { success: true, duplicate: true };
   }
   ```

### Messages Out of Order

**Symptoms:**
- Messages arrive in wrong order
- Typing indicator shows after message

**Solutions:**

1. **Use delay parameter**
   ```json
   {
     "action": "message.send",
     "sessionId": "...",
     "payload": { ... },
     "delay": 500  // ms
   }
   ```

2. **Sequence messages**
   ```typescript
   // Send in sequence with delays
   await sendMessage({ content: "First", delay: 0 });
   await sendMessage({ content: "Second", delay: 1000 });
   ```

## Debugging Tools

### Enable Debug Logging

```typescript
import { Logger } from './utils/logger';

const logger = new Logger('Debug');
logger.setLevel('debug');
```

### Test Webhook Locally

```bash
# Use ngrok for local testing
ngrok http 3000

# Update webhook URL
# n8n webhook: https://your-ngrok-url.ngrok.io/api/v1/n8n/webhook/inbound
```

### Monitor Events

```typescript
// Subscribe to events
n8nModule.circuitBreaker.onStateChange((state, prevState) => {
  console.log(`Circuit: ${prevState} -> ${state}`);
});

n8nModule.retryService.on('completed', (job) => {
  console.log(`Job completed: ${job.id}`);
});
```

### Health Check Script

```bash
#!/bin/bash
# health-check.sh

echo "=== n8n Integration Health Check ==="

# Check API health
curl -s https://api.chatbot-platform.com/api/v1/n8n/webhook/health | jq .

# Check circuit status
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.chatbot-platform.com/api/v1/n8n/webhook/circuit-status | jq .

# Check queue status
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.chatbot-platform.com/api/v1/n8n/webhook/queue-status | jq .

# Test inbound webhook
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{"action":"typing.start","sessionId":"test-session"}' \
  https://api.chatbot-platform.com/api/v1/n8n/webhook/inbound | jq .

echo "=== Health Check Complete ==="
```

## Getting Help

If issues persist:

1. **Check documentation**
   - [Integration Guide](./n8n-integration.md)
   - [API Reference](./webhook-reference.md)
   - [Message Format](./message-format.md)

2. **Review logs**
   ```bash
   # Collect all logs
   tar -czf logs.tar.gz /var/log/chatbot/
   ```

3. **Contact support**
   - Email: support@chatbot-platform.com
   - Include: logs, error messages, reproduction steps

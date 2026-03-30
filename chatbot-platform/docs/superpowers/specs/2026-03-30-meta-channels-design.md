# Meta Channels Design Spec (Messenger + Instagram)

## Goal

Add Facebook Messenger and Instagram DM channels to the chatbot platform, building on the existing multi-channel foundation. Tenants connect their Facebook Pages and Instagram Business accounts via OAuth. A single Meta App owned by the platform handles all tenants.

## Scope

- Facebook Messenger (Page-based messaging)
- Instagram DMs (via linked Instagram Business/Creator accounts)
- Full OAuth flow for tenant onboarding
- NOT included: WhatsApp (separate plan — different complexity with templates, phone numbers, WABA)

## Key Decisions

1. **Single platform Meta App** — one Facebook App for all tenants. Tenants OAuth their Pages into it. App secret and verify token stored in environment config, not per-tenant.
2. **Shared inbound, separate outbound** — one webhook endpoint and event normalizer for both channels. Separate outbound transports with different capability profiles.
3. **Dedicated Meta webhook route** — does NOT go through the generic `/:channel/webhook` router. Meta needs raw body for HMAC verification and app-level challenge verification (not per-connection).
4. **`messenger` and `instagram` as stored channel types** — not `meta`. Sessions, connections, and outbound routing use the specific channel type.

## Architecture

### Webhook Ingress

```
POST /api/v1/channels/meta/webhook
  → Raw body middleware (express.raw, NOT express.json)
  → Verify X-Hub-Signature-256 with APP_SECRET from env
  → Parse JSON from raw body
  → For each entry[].messaging[] event:
      → Extract recipient.id (Page ID)
      → Look up ChannelConnection by platformAccountId = page_id
      → Determine channel type (messenger or instagram) from connection
      → Normalize to NormalizedEvent[]
      → Feed into existing inbound pipeline

GET /api/v1/channels/meta/webhook
  → Verify hub.verify_token matches META_VERIFY_TOKEN from env
  → Return hub.challenge
```

This route is mounted separately in `server.ts` with `express.raw()` middleware, similar to how Clerk webhooks are handled.

### OAuth Flow

```
1. Portal: Tenant clicks "Connect Facebook"
2. Redirect to: https://www.facebook.com/v21.0/dialog/oauth
   ?client_id={APP_ID}
   &redirect_uri={BASE_URL}/api/v1/channels/meta/oauth/callback
   &scope=pages_messaging,pages_read_engagement,pages_manage_metadata,instagram_basic,instagram_manage_messages
   &state={encrypted_tenant_id + nonce}

3. User grants permissions, redirected to callback with ?code=...&state=...

4. Backend callback:
   a. Validate state (decrypt, check nonce, extract tenantId)
   b. Exchange code for short-lived user token
   c. Exchange short-lived for long-lived user token (60-day)
   d. GET /me/accounts to list Pages the user manages
   e. For each Page: get long-lived page token (does not expire)
   f. For each Page: check for linked Instagram Business account
   g. Return list of available Pages + IG accounts to frontend

5. Portal: Tenant selects which Pages/IG accounts to connect

6. Backend: For each selected Page:
   a. Subscribe Page to app webhooks (POST /{page_id}/subscribed_apps)
   b. Create ChannelConnection (channel='messenger', platformAccountId=page_id)
   c. If IG account linked: create ChannelConnection (channel='instagram', platformAccountId=page_id)
   d. Store encrypted page_access_token in credentials
```

### Environment Config

```
META_APP_ID=...
META_APP_SECRET=...          # For HMAC verification + token exchange
META_VERIFY_TOKEN=...        # For webhook challenge verification
META_OAUTH_REDIRECT_URI=...  # Callback URL
```

These are NOT stored per-tenant. One app for the whole platform.

### Connection Resolution

Meta webhooks contain `entry[].messaging[].recipient.id` which is the Page ID. Resolution:

```typescript
// Look up by platformAccountId (page_id) + active status
const connection = await connectionRepo.findOne({
  where: { platformAccountId: pageId, status: 'active' }
});
```

**Uniqueness constraint:** Add `UNIQUE(platformAccountId, channel)` to `channel_connections` to prevent the same Page being connected by two tenants. If a tenant tries to connect an already-connected Page, return an error.

### Event Normalization

Meta webhook payload structure:
```json
{
  "object": "page",  // or "instagram"
  "entry": [{
    "id": "PAGE_ID",
    "time": 1711756800,
    "messaging": [{
      "sender": { "id": "USER_PSID" },
      "recipient": { "id": "PAGE_ID" },
      "timestamp": 1711756800000,
      "message": {
        "mid": "m_abc123",
        "text": "Hello"
      }
    }]
  }]
}
```

Normalized event mapping:
- `message.text` → NormalizedEvent type='message', message.type='text'
- `message.attachments[].type='image'` → message.type='image' with mediaUrl
- `message.attachments[].type='video'` → message.type='video'
- `message.attachments[].type='audio'` → message.type='audio'
- `message.attachments[].type='file'` → message.type='file'
- `postback.payload` → type='postback'
- `delivery.mids[]` → type='delivery'
- `read.watermark` → type='read'
- `referral` → type='referral' (logged but not processed as message)

Dedupe key: `meta:{entry.id}:{messaging.message.mid}` for messages, `meta:{entry.id}:postback:{timestamp}` for postbacks.

### Outbound Transport

**Messenger capabilities:**
```typescript
maxTextLength: 2000
supportsQuickReplies: true, maxQuickReplies: 13
supportsButtons: true, maxButtons: 3
supportsCarousel: true, maxCarouselCards: 10
supportsImages/Video/Audio/Files: true
supportsTypingIndicator: true
supportsReadReceipts: false (platform-managed)
hasMessagingWindow: true, messagingWindowHours: 24
requiresTemplatesOutsideWindow: true
```

**Instagram capabilities:**
```typescript
maxTextLength: 1000
supportsQuickReplies: true, maxQuickReplies: 13
supportsButtons: false
supportsCarousel: false
supportsImages: true
supportsVideo: false
supportsAudio: false
supportsFiles: false
supportsTypingIndicator: false
hasMessagingWindow: true, messagingWindowHours: 24
requiresTemplatesOutsideWindow: false // IG doesn't support templates
```

Send API for both: `POST https://graph.facebook.com/v21.0/me/messages` with page_access_token as Bearer token.

### 24-Hour Messaging Window

Meta enforces a 24-hour window from the user's last message. Outside this window:
- Messenger: can send message tags (limited use cases: confirmed_event_update, post_purchase_update, account_update) or sponsored messages
- Instagram: cannot send outside window (no template system)

For v1: **Log a warning when attempting to send outside the window** and let Meta's API return the error. Do not block sends — the error from Meta is the source of truth. Track the last inbound message timestamp on the ConversationBinding for future window enforcement.

### File Structure

```
chatbot-platform/api/src/channels/meta/
├── index.ts                    # Exports adapters + registers both
├── webhook.routes.ts           # Dedicated raw-body route (mounted separately)
├── oauth.service.ts            # OAuth flow: redirect URL, callback, token exchange
├── oauth.routes.ts             # OAuth API endpoints
├── event-normalizer.ts         # Shared normalizer for both channels
├── messenger-transport.ts      # Messenger Send API + capabilities
├── instagram-transport.ts      # IG Send API + capabilities
├── setup.service.ts            # Page subscription, IG account detection
└── connection-resolver.ts      # Page ID → ChannelConnection lookup
```

### Portal UI (Settings Page)

At `/settings/channels`:
- List all connected channels (Telegram bots, Facebook Pages, IG accounts) with status badges
- "Connect Telegram" button → existing bot token modal
- "Connect Facebook" button → OAuth redirect flow
- Each connection shows: channel icon, label, status (active/error/disconnected), last activity
- Disconnect button per connection with confirmation dialog
- Error state shows last error message with "Reconnect" action

### Database Changes

1. Add unique constraint: `UNIQUE(platformAccountId, channel)` on `channel_connections`
2. Add `lastInboundAt` timestamp to `conversation_bindings` (for future messaging window tracking)

### Security

- Meta app secret in environment, never in database
- Page access tokens encrypted via existing `credential-utils.ts`
- OAuth state parameter encrypted with nonce for CSRF protection
- Raw body HMAC verification before any JSON parsing
- Webhook verify token in environment for challenge verification

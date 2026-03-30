# Meta Channels Design Spec (Messenger + Instagram)

## Goal

Add Facebook Messenger and Instagram DM channels to the chatbot platform, building on the existing multi-channel foundation. Tenants connect their Facebook Pages and Instagram Business accounts via OAuth. A single Meta App owned by the platform handles all tenants.

## Scope

- Facebook Messenger (Page-based messaging)
- Instagram DMs (via linked Instagram Business/Creator accounts)
- Full OAuth flow for tenant onboarding (Facebook Login — may add Instagram Login later)
- Human agent continuation via HUMAN_AGENT tag
- Profile enrichment (names/avatars in agent inbox)
- NOT included: WhatsApp (separate plan — different complexity with templates, phone numbers, WABA)

## Key Decisions

1. **Single platform Meta App** — one Facebook App for all tenants. Tenants OAuth their Pages into it. App secret and verify token stored in environment config, not per-tenant.
2. **Shared inbound, separate outbound** — one webhook endpoint and event normalizer for both channels. Separate outbound transports with different capability profiles and API endpoints.
3. **Dedicated Meta webhook route** — does NOT go through the generic `/:channel/webhook` router. Meta needs raw body for HMAC verification and app-level challenge verification (not per-connection). One webhook payload can contain events for multiple Pages/channels.
4. **`messenger` and `instagram` as stored channel types** — not `meta`. Sessions, connections, and outbound routing use the specific channel type.
5. **Separate identity for Instagram** — IG connections store `igUserId` (Instagram-scoped user ID) in addition to `pageId`. IG webhook resolution and Send API use the IG user ID, not the Page ID.
6. **Facebook Login flow** — tenants log in with Facebook, app accesses linked IG accounts via the Page. May add Instagram Login as an alternative later.

## Architecture

### Webhook Ingress

```
POST /api/v1/channels/meta/webhook
  → Raw body middleware (express.raw, NOT express.json)
  → Verify X-Hub-Signature-256: HMAC-SHA256(raw_body, APP_SECRET) from env
  → Parse JSON from raw body
  → Determine object type: "page" (Messenger) or "instagram" (IG)
  → For each entry[]:
      → For each messaging[] event:
          → Skip if is_echo=true (our own messages echoed back)
          → Extract recipient.id (Page ID for Messenger, IG User ID for Instagram)
          → Look up ChannelConnection by platformAccountId + channel
          → Normalize to NormalizedEvent[]
          → Feed into existing inbound pipeline (dedupe → save → forward)

GET /api/v1/channels/meta/webhook
  → Verify hub.verify_token matches META_VERIFY_TOKEN from env
  → Return hub.challenge (plain text, status 200)
```

This route is mounted in `server.ts` BEFORE `express.json()`, with `express.raw({ type: 'application/json' })`, same pattern as Clerk webhooks.

### Meta Ingress Dispatcher

The generic `channel-webhook.routes.ts` resolves one connection per request. Meta is different — one webhook can contain events for multiple Pages/channels. The Meta webhook route acts as its own dispatcher:

1. Verify signature once (app-level, not per-connection)
2. Parse and iterate `entry[].messaging[]`
3. For each event, resolve connection by recipient ID + object type
4. If connection not found, skip event (log warning)
5. Normalize and feed each event independently into inbound pipeline

This keeps the Meta route self-contained without forcing changes to the generic router.

### OAuth Flow

```
1. Portal: Tenant clicks "Connect Facebook"
   → Frontend calls GET /api/v1/channels/meta/oauth/url
   → Backend returns Facebook Login URL with state parameter

2. Redirect to: https://www.facebook.com/v21.0/dialog/oauth
   ?client_id={META_APP_ID}
   &redirect_uri={META_OAUTH_REDIRECT_URI}  (from env, never request-derived)
   &scope=pages_messaging,pages_read_engagement,pages_manage_metadata,pages_show_list,instagram_basic,instagram_business_manage_messages
   &state={signed_jwt: tenantId, nonce, exp=5min}

3. User grants permissions, redirected to callback with ?code=...&state=...

4. Backend callback (GET /api/v1/channels/meta/oauth/callback):
   a. Validate state JWT (verify signature, check expiry, extract tenantId)
   b. Exchange code for short-lived user token
      POST https://graph.facebook.com/v21.0/oauth/access_token
   c. Exchange for long-lived user token (60-day)
      GET https://graph.facebook.com/v21.0/oauth/access_token
        ?grant_type=fb_exchange_token&fb_exchange_token={short_lived_token}
   d. GET /me/accounts?fields=id,name,access_token,picture,tasks,instagram_business_account
      → Filter pages by tasks (must include MESSAGING)
   e. For each Page with MESSAGING task:
      → The returned access_token is already a long-lived page token (does not expire)
      → Check instagram_business_account field for linked IG
   f. Store available Pages + IG accounts in a temporary session/cache
   g. Redirect to portal with session token: /settings/channels?meta_setup={session_token}

5. Portal: Fetches available Pages/IG accounts, tenant selects which to connect
   → POST /api/v1/channels/meta/connect with selected page IDs

6. Backend: For each selected Page:
   a. Subscribe Page to app webhooks
      POST /{page_id}/subscribed_apps?subscribed_fields=messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads
   b. Create ChannelConnection:
      channel='messenger', platformAccountId=page_id
      credentials={ pageAccessToken: encrypted, pageId }
      config={ pageName, pageImageUrl }
   c. If IG account linked:
      → Get IG user ID from instagram_business_account
      → Subscribe IG to webhooks: POST /{ig_user_id}/subscribed_apps
      → Create ChannelConnection:
        channel='instagram', platformAccountId=ig_user_id
        credentials={ pageAccessToken: encrypted, pageId, igUserId }
        config={ igUsername, igProfilePicUrl }
```

### Environment Config

```
META_APP_ID=...
META_APP_SECRET=...            # HMAC verification + token exchange
META_VERIFY_TOKEN=...          # Webhook challenge verification
META_OAUTH_REDIRECT_URI=...    # Fixed callback URL (from env, not request)
META_OAUTH_JWT_SECRET=...      # For signing OAuth state JWTs
```

### Connection Resolution

**Messenger:** `entry[].messaging[].recipient.id` = Page ID
```typescript
const connection = await connectionRepo.findOne({
  where: { platformAccountId: pageId, channel: 'messenger', status: 'active' }
});
```

**Instagram:** `entry[].messaging[].recipient.id` = IG User ID
```typescript
const connection = await connectionRepo.findOne({
  where: { platformAccountId: igUserId, channel: 'instagram', status: 'active' }
});
```

**Uniqueness constraint:** `UNIQUE(platformAccountId, channel)` on `channel_connections`. Same Page/IG account cannot be connected by two tenants.

### Event Normalization

Meta webhook payload structure:
```json
{
  "object": "page",
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

Event mapping:
| Meta Event | NormalizedEvent Type | Notes |
|-----------|---------------------|-------|
| `message.text` | message, type='text' | |
| `message.attachments[].type='image'` | message, type='image' | mediaUrl from attachment.payload.url |
| `message.attachments[].type='video'` | message, type='video' | |
| `message.attachments[].type='audio'` | message, type='audio' | |
| `message.attachments[].type='file'` | message, type='file' | |
| `message.quick_reply` | postback | quick_reply.payload as postback payload |
| `message.is_echo=true` | skip | Our own messages echoed back |
| `postback.payload` | postback | |
| `delivery.mids[]` | delivery | Update MessageDelivery status |
| `read.watermark` | read | Update MessageDelivery status |
| `referral` | referral | Logged, not processed as message |
| `reaction` | status | Logged, not processed as message |
| `message_edit` | status | Logged, future: update existing message |

Dedupe key format: `meta:{object}:{entry.id}:{sender.id}:{message.mid}` for messages. For postbacks: `meta:{object}:{entry.id}:{sender.id}:postback:{timestamp}:{payload_hash}`.

### Outbound Transport

**Messenger:**
- Endpoint: `POST https://graph.facebook.com/v21.0/{page_id}/messages`
- Auth: `?access_token={page_access_token}`
- Capabilities:
  ```
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
- Required field: `messaging_type: 'RESPONSE'` (within window) or `'MESSAGE_TAG'` (outside)
- Typing: `POST /{page_id}/messages` with `sender_action: 'typing_on'`
- Mark seen: `sender_action: 'mark_seen'`

**Instagram:**
- Endpoint: `POST https://graph.instagram.com/v21.0/{ig_user_id}/messages` (note: graph.instagram.com, not graph.facebook.com)
- Auth: `?access_token={page_access_token}` (uses the linked Page's token)
- Capabilities:
  ```
  maxTextLength: 1000
  supportsQuickReplies: true, maxQuickReplies: 13
  supportsButtons: true, maxButtons: 3
  supportsCarousel: true, maxCarouselCards: 10
  supportsImages: true
  supportsVideo: true
  supportsAudio: true
  supportsFiles: false
  supportsTypingIndicator: false
  supportsReadReceipts: false
  hasMessagingWindow: true, messagingWindowHours: 24
  requiresTemplatesOutsideWindow: false
  ```

### Human Agent Support

When an agent in the portal takes over a conversation (handoff), outbound messages should use:
- **Messenger:** `messaging_type: 'MESSAGE_TAG'` with `tag: 'HUMAN_AGENT'` — allows sending up to 7 days after last user message
- **Instagram:** `HUMAN_AGENT` tag available — same 7-day window

The outbound transport checks the session status. If `status === 'active'` (agent assigned), use HUMAN_AGENT tag. If `status === 'bot'`, use RESPONSE type.

### Profile Enrichment

Meta messaging events don't include sender names/avatars. When creating a new ConversationBinding:
1. Call `GET https://graph.facebook.com/v21.0/{sender_psid}?fields=first_name,last_name,profile_pic&access_token={page_token}`
2. Store `displayName` and `avatarUrl` on the ConversationBinding
3. Cache profiles for 24h to avoid excessive API calls
4. Gracefully degrade if profile fetch fails (use "Facebook User" / "Instagram User" as fallback)

### 24-Hour Messaging Window

For v1: Let Meta's API enforce the window. If a send fails with error code 10 (outside window), log the error and surface it to the agent in the portal. Track `lastInboundAt` on ConversationBinding for future proactive enforcement.

### File Structure

```
chatbot-platform/api/src/channels/meta/
├── index.ts                    # Exports + registers messenger and instagram adapters
├── webhook.routes.ts           # Dedicated raw-body route with HMAC verification
├── oauth.service.ts            # OAuth: build URL, exchange tokens, list pages
├── oauth.routes.ts             # GET /oauth/url, GET /oauth/callback, POST /connect
├── event-normalizer.ts         # Shared normalizer for both channels
├── connection-resolver.ts      # Page ID / IG User ID → ChannelConnection
├── messenger-transport.ts      # Messenger Send API + capabilities
├── instagram-transport.ts      # IG Send API + capabilities
├── setup.service.ts            # Page/IG subscription, connection creation
├── profile.service.ts          # Profile fetch + caching for sender names/avatars
└── disconnect.service.ts       # Unsubscribe + cleanup on disconnect
```

### Portal UI (Settings Page)

At `/settings/channels`:
- List all connected channels (Telegram bots, Facebook Pages, IG accounts) with status badges
- "Connect Telegram" button → bot token modal
- "Connect Facebook" button → OAuth redirect flow
- Each connection shows: channel icon, label, status (active/error/disconnected), last activity
- Disconnect button per connection with confirmation dialog
- Error state shows last error message with "Reconnect" action

### Database Changes

1. Add unique constraint: `UNIQUE(platformAccountId, channel)` on `channel_connections`
2. Add `lastInboundAt` timestamp to `conversation_bindings` (messaging window tracking)
3. New migration for both changes

### Disconnect Flow

When a tenant disconnects a Meta connection:
1. Unsubscribe from webhooks: `DELETE /{page_id}/subscribed_apps` (Messenger) or `DELETE /{ig_user_id}/subscribed_apps` (IG)
2. Clear encrypted credentials from ChannelConnection
3. Mark connection as `disconnected`
4. If disconnecting a Page that has a linked IG connection, also disconnect the IG connection

### Token Health

- Page access tokens derived from long-lived user tokens do not expire
- However, tokens can be invalidated if: user changes password, user removes app, page admin changes, app is deauthorized
- Add a periodic health check (daily): call `GET /{page_id}?access_token={token}` — if 401/403, mark connection as `error` with descriptive message
- Surface errors in the portal channels page with a "Reconnect" action

### Security

- Meta app secret in environment, never in database
- Page access tokens encrypted via existing `credential-utils.ts`
- OAuth state as signed JWT with 5-minute expiry (CSRF + replay protection)
- Raw body HMAC verification before any JSON parsing
- Webhook verify token in environment for challenge verification
- OAuth redirect URI from environment config (never derived from request)
- Skip `is_echo` events to prevent feedback loops

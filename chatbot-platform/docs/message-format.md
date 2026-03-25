# Message Format Specification

Complete specification for all message formats used in n8n integration.

## Table of Contents

- [Outbound Messages (Platform → n8n)](#outbound-messages-platform--n8n)
- [Inbound Messages (n8n → Platform)](#inbound-messages-n8n--platform)
- [Quick Replies](#quick-replies)
- [Message Types](#message-types)
- [User Context](#user-context)
- [Chat Context](#chat-context)

## Outbound Messages (Platform → n8n)

Sent when user interacts with the chatbot.

### Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["event", "tenantId", "sessionId", "timestamp", "payload"],
  "properties": {
    "event": {
      "type": "string",
      "enum": [
        "message.received",
        "message.sent",
        "session.started",
        "session.ended",
        "user.typing",
        "file.uploaded",
        "handsoff.requested",
        "handsoff.accepted",
        "handsoff.released"
      ]
    },
    "tenantId": { "type": "string", "format": "uuid" },
    "sessionId": { "type": "string", "format": "uuid" },
    "timestamp": { "type": "string", "format": "date-time" },
    "payload": { "$ref": "#/definitions/payload" },
    "user": { "$ref": "#/definitions/user" },
    "context": { "$ref": "#/definitions/context" }
  }
}
```

### Examples

#### Text Message Received

```json
{
  "event": "message.received",
  "tenantId": "550e8400-e29b-41d4-a716-446655440001",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "payload": {
    "type": "text",
    "content": "Hello, I need help with my order!"
  },
  "user": {
    "anonymousId": "550e8400-e29b-41d4-a716-446655440002",
    "browser": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "ip": "a1b2c3d4e5f6789a",
    "geo": {
      "country": "United States",
      "countryCode": "US",
      "city": "New York",
      "timezone": "America/New_York"
    },
    "device": {
      "type": "desktop",
      "os": "Windows",
      "browser": "Chrome"
    }
  },
  "context": {
    "previousMessages": [
      {
        "role": "assistant",
        "content": "Welcome! How can I help you today?",
        "timestamp": "2024-01-15T10:29:30.000Z"
      }
    ],
    "pageUrl": "https://example.com/support",
    "referrer": "https://google.com",
    "utmParams": {
      "source": "google",
      "medium": "cpc",
      "campaign": "support_chat"
    }
  }
}
```

#### Image Uploaded

```json
{
  "event": "file.uploaded",
  "tenantId": "550e8400-e29b-41d4-a716-446655440001",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "payload": {
    "type": "image",
    "content": "https://cdn.example.com/uploads/image123.jpg",
    "metadata": {
      "filename": "screenshot.png",
      "mimeType": "image/png",
      "size": 245760,
      "width": 1920,
      "height": 1080
    }
  },
  "user": {
    "anonymousId": "550e8400-e29b-41d4-a716-446655440002"
  }
}
```

#### Session Started

```json
{
  "event": "session.started",
  "tenantId": "550e8400-e29b-41d4-a716-446655440001",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "payload": {
    "type": "text",
    "content": "Session started"
  },
  "user": {
    "anonymousId": "550e8400-e29b-41d4-a716-446655440002",
    "externalId": "user_12345",
    "email": "john@example.com",
    "name": "John Doe"
  },
  "context": {
    "pageUrl": "https://example.com/pricing"
  }
}
```

## Inbound Messages (n8n → Platform)

Sent from n8n to control the chatbot.

### Schema

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["action", "sessionId"],
  "properties": {
    "action": {
      "type": "string",
      "enum": [
        "message.send",
        "message.edit",
        "message.delete",
        "typing.start",
        "typing.stop",
        "handsoff.trigger",
        "handsoff.release",
        "file.request",
        "session.clear",
        "session.transfer",
        "user.update"
      ]
    },
    "sessionId": { "type": "string", "format": "uuid" },
    "tenantId": { "type": "string", "format": "uuid" },
    "payload": { "$ref": "#/definitions/responsePayload" },
    "delay": { "type": "number", "minimum": 0, "maximum": 30000 },
    "priority": { "type": "string", "enum": ["low", "normal", "high", "urgent"] },
    "options": {
      "type": "object",
      "properties": {
        "ephemeral": { "type": "boolean" },
        "silent": { "type": "boolean" },
        "requireConfirmation": { "type": "boolean" }
      }
    }
  }
}
```

### Examples

#### Send Text Message

```json
{
  "action": "message.send",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "type": "text",
    "content": "Hello! How can I help you today?",
    "quickReplies": ["Pricing", "Support", "Demo"]
  },
  "delay": 500
}
```

#### Send Message with Quick Replies

```json
{
  "action": "message.send",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "type": "quick_reply",
    "content": "What would you like to do?",
    "quickReplies": [
      {
        "id": "pricing",
        "title": "View Pricing",
        "value": "pricing",
        "action": "send",
        "icon": "💰"
      },
      {
        "id": "support",
        "title": "Get Support",
        "value": "support",
        "action": "send",
        "icon": "🆘"
      },
      {
        "id": "human",
        "title": "Talk to Human",
        "value": "human",
        "action": "send",
        "icon": "👤"
      }
    ]
  }
}
```

#### Send Image

```json
{
  "action": "message.send",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "type": "image",
    "content": "https://example.com/image.jpg",
    "metadata": {
      "filename": "product.jpg",
      "width": 800,
      "height": 600
    }
  }
}
```

#### Trigger Human Handoff

```json
{
  "action": "handsoff.trigger",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "reason": "Customer requested human agent",
    "priority": "high",
    "queue": "priority_support",
    "department": "sales",
    "tags": ["escalated", "vip"],
    "summary": "Customer interested in enterprise pricing"
  }
}
```

#### Request File Upload

```json
{
  "action": "file.request",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "types": ["image", "document"],
    "maxSize": 10485760,
    "maxFiles": 1,
    "accept": "image/*,.pdf,.doc,.docx",
    "prompt": "Please upload a screenshot of the issue"
  }
}
```

#### Start Typing Indicator

```json
{
  "action": "typing.start",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### Stop Typing Indicator

```json
{
  "action": "typing.stop",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### Edit Message

```json
{
  "action": "message.edit",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "metadata": {
      "messageId": "msg_1234567890"
    },
    "content": "Updated message content"
  }
}
```

#### Delete Message

```json
{
  "action": "message.delete",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "metadata": {
      "messageId": "msg_1234567890"
    }
  }
}
```

#### Clear Session

```json
{
  "action": "session.clear",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### Transfer Session

```json
{
  "action": "session.transfer",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "target": "billing_department",
    "reason": "Billing inquiry"
  }
}
```

#### Update User Context

```json
{
  "action": "user.update",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "payload": {
    "email": "john@example.com",
    "name": "John Doe",
    "customData": {
      "plan": "enterprise",
      "company": "Acme Inc"
    }
  }
}
```

## Quick Replies

Quick replies provide interactive buttons for users.

### Simple Format

```json
{
  "quickReplies": ["Option 1", "Option 2", "Option 3"]
}
```

### Advanced Format

```json
{
  "quickReplies": [
    {
      "id": "option_1",
      "title": "Option 1",
      "value": "option_1_value",
      "action": "send",
      "icon": "✅",
      "style": {
        "backgroundColor": "#007bff",
        "textColor": "#ffffff",
        "borderRadius": 8
      },
      "metadata": {
        "category": "primary"
      }
    },
    {
      "id": "option_2",
      "title": "Option 2",
      "value": "option_2_value",
      "action": "url",
      "url": "https://example.com"
    },
    {
      "id": "option_3",
      "title": "Call Us",
      "value": "+1234567890",
      "action": "phone"
    }
  ]
}
```

### Quick Reply Actions

| Action | Description |
|--------|-------------|
| `send` | Send value as message |
| `url` | Open URL in browser |
| `phone` | Initiate phone call |
| `email` | Open email client |
| `postback` | Send postback to n8n |
| `location` | Request user location |
| `camera` | Open camera/file picker |

## Message Types

### Supported Types

| Type | Description | Example Use |
|------|-------------|-------------|
| `text` | Plain text message | General responses |
| `image` | Image file or URL | Product images, screenshots |
| `video` | Video file or URL | Tutorials, demos |
| `audio` | Audio file or URL | Voice messages |
| `file` | Generic file attachment | Documents, PDFs |
| `location` | Geographic coordinates | Store locations |
| `contact` | Contact information | Sharing contacts |
| `quick_reply` | Message with quick reply buttons | Interactive responses |
| `carousel` | Horizontal scrollable cards | Product showcases |
| `template` | Structured message template | Rich media messages |

### Carousel Format

```json
{
  "type": "carousel",
  "content": [
    {
      "title": "Product 1",
      "subtitle": "Best seller",
      "imageUrl": "https://example.com/product1.jpg",
      "buttons": [
        {
          "title": "Buy Now",
          "type": "url",
          "url": "https://example.com/buy/1"
        },
        {
          "title": "Learn More",
          "type": "postback",
          "payload": "product_1_details"
        }
      ]
    },
    {
      "title": "Product 2",
      "subtitle": "New arrival",
      "imageUrl": "https://example.com/product2.jpg",
      "buttons": [
        {
          "title": "Buy Now",
          "type": "url",
          "url": "https://example.com/buy/2"
        }
      ]
    }
  ]
}
```

### Template Format

```json
{
  "type": "template",
  "content": {
    "template_type": "button",
    "text": "Choose an option:",
    "buttons": [
      {
        "type": "postback",
        "title": "Option 1",
        "payload": "option_1"
      },
      {
        "type": "url",
        "title": "Visit Website",
        "url": "https://example.com"
      }
    ]
  }
}
```

## User Context

### Full User Object

```json
{
  "user": {
    "anonymousId": "550e8400-e29b-41d4-a716-446655440002",
    "externalId": "user_12345",
    "email": "john@example.com",
    "name": "John Doe",
    "browser": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)...",
    "ip": "a1b2c3d4e5f6789a",
    "geo": {
      "country": "United States",
      "countryCode": "US",
      "region": "California",
      "city": "San Francisco",
      "timezone": "America/Los_Angeles",
      "lat": 37.7749,
      "lng": -122.4194
    },
    "device": {
      "type": "desktop",
      "os": "Windows 10",
      "browser": "Chrome",
      "version": "120.0"
    },
    "customData": {
      "plan": "enterprise",
      "company": "Acme Inc",
      "role": "admin"
    }
  }
}
```

## Chat Context

### Full Context Object

```json
{
  "context": {
    "previousMessages": [
      {
        "role": "assistant",
        "content": "Welcome! How can I help?",
        "timestamp": "2024-01-15T10:29:30.000Z",
        "metadata": {
          "messageId": "msg_001"
        }
      },
      {
        "role": "user",
        "content": "I need pricing info",
        "timestamp": "2024-01-15T10:29:45.000Z"
      }
    ],
    "intent": "pricing_inquiry",
    "confidence": 0.95,
    "entities": [
      {
        "type": "product",
        "value": "enterprise",
        "confidence": 0.92
      }
    ],
    "pageUrl": "https://example.com/pricing",
    "referrer": "https://google.com/search?q=pricing",
    "utmParams": {
      "source": "google",
      "medium": "cpc",
      "campaign": "spring_sale",
      "term": "enterprise pricing",
      "content": "ad_variant_a"
    },
    "customContext": {
      "chatbotVersion": "2.1.0",
      "featureFlags": ["new_ui", "ai_responses"]
    }
  }
}
```

## File Metadata

### Image Metadata

```json
{
  "metadata": {
    "filename": "screenshot.png",
    "mimeType": "image/png",
    "size": 245760,
    "width": 1920,
    "height": 1080,
    "url": "https://cdn.example.com/uploads/image123.png"
  }
}
```

### Document Metadata

```json
{
  "metadata": {
    "filename": "contract.pdf",
    "mimeType": "application/pdf",
    "size": 1048576,
    "url": "https://cdn.example.com/uploads/contract.pdf"
  }
}
```

### Video Metadata

```json
{
  "metadata": {
    "filename": "demo.mp4",
    "mimeType": "video/mp4",
    "size": 5242880,
    "duration": 120,
    "url": "https://cdn.example.com/uploads/demo.mp4"
  }
}
```

## Validation

All messages are validated against JSON schemas. Validation errors return:

```json
{
  "success": false,
  "error": "Invalid message format",
  "details": [
    {
      "path": ".payload.content",
      "message": "should be string"
    },
    {
      "path": ".sessionId",
      "message": "should match format \"uuid\""
    }
  ]
}
```

## Size Limits

| Field | Limit |
|-------|-------|
| Message content | 10,000 characters |
| Quick replies | 10 items max |
| Quick reply title | 20 characters max |
| Carousel cards | 10 items max |
| Previous messages | 10 items max |
| Custom data | 100KB max |
| File uploads | 10MB default |

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2024-01-15 | Initial release |
| 1.1.0 | 2024-02-01 | Added carousel type |
| 1.2.0 | 2024-03-01 | Added template type |

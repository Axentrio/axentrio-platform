# No-Code Automations Design Spec

**Date:** 2026-04-03
**Status:** Draft
**Scope:** Built-in automations (email notifications, CRM sync) with toggle-on/off configuration. No external tools required for common use cases.

---

## 1. Overview

Agencies configure post-conversation automations through a simple dashboard — toggles and templates, not webhook URLs. The platform handles email delivery, CRM sync, and notifications internally. Advanced users can still use custom webhooks.

**The agency experience:**
1. Sign up → bot works immediately (smart defaults)
2. Dashboard → Automations page → toggle "Send booking confirmation" ON
3. Done. Customer gets an email when they book.

**What we DON'T build:** Email campaigns, drip sequences, newsletters, A/B testing, template designers. We send specific, triggered transactional emails.

---

## 2. Automation Types (Phase 1)

### 2.1 Email Notifications (4 pre-built)

| Automation | Trigger Event | Recipient | Default Template |
|-----------|--------------|-----------|-----------------|
| Booking confirmation | `appointment.booked` | Customer (attendeeEmail) | "Your appointment is confirmed for {date} at {time}." |
| New lead alert | `lead.created` | Team (configured emails) | "New lead: {name} ({email}) via {channel}" |
| Conversation summary | `conversation.ended` | Team (configured emails) | "Chat ended: {messageCount} messages, {duration}min. Tags: {tags}" |
| Follow-up email | `conversation.ended` + 24h delay | Customer (if email captured) | "Thanks for chatting with us! If you need anything else..." |

### 2.2 CRM Sync (Phase 2 — design now, build later)

| Automation | Trigger Event | Action |
|-----------|--------------|--------|
| GoHighLevel sync | `lead.created` | Create/update GHL contact via API |
| HubSpot sync | `lead.created` | Create/update HubSpot contact via API |

### 2.3 Custom Webhook (Already Built)

The existing webhook system (`src/webhooks/`) serves as the "Advanced" escape hatch for developers.

---

## 3. Architecture

```
Event fires (lead.created / appointment.booked / conversation.ended)
    │
    ▼
AutomationEngine.process(event, tenant)
    │
    ├── Check tenant.settings.automations[] for matching rules
    │
    ├── Email automations:
    │   → Render template with event data
    │   → Send via Resend API (transactional email service)
    │   → Log delivery in automation_logs
    │
    ├── CRM automations (Phase 2):
    │   → Map event data to CRM contact schema
    │   → Call GHL/HubSpot API
    │   → Log sync result
    │
    └── Webhook automations (existing):
        → emitWebhookEvent() (already built)
```

### 3.1 Email Service: Resend

**Why Resend:**
- Free tier: 100 emails/day (plenty for early stage)
- Single API call: `POST https://api.resend.com/emails`
- Per-tenant "from" address via Resend domains
- Simple SDK: `npm install resend`
- No deliverability setup needed (they handle SPF/DKIM)

**Alternative:** SendGrid, Postmark — same pattern, swap the API call.

### 3.2 Template Engine

Templates use simple `{variable}` interpolation (not Handlebars — too complex for this).

Available variables per event type:

| Variable | Available In | Example |
|----------|-------------|---------|
| `{name}` | lead.created, appointment.booked | "Sarah Connor" |
| `{email}` | lead.created, appointment.booked | "sarah@example.com" |
| `{date}` | appointment.booked | "Monday, April 7" |
| `{time}` | appointment.booked | "1:30 PM" |
| `{bookingId}` | appointment.booked | "bk_abc123" |
| `{messageCount}` | conversation.ended | "12" |
| `{duration}` | conversation.ended | "5" (minutes) |
| `{tags}` | conversation.ended | "booking_intent, lead_captured" |
| `{channel}` | all | "widget" / "telegram" / "messenger" |
| `{tenantName}` | all | "Amsterdam Dental Clinic" |
| `{botName}` | all | "DentalBot" |

---

## 4. Tenant Settings Schema

```typescript
// In tenant.settings (JSONB)
automations: {
  emailNotifications: {
    bookingConfirmation: {
      enabled: boolean;          // default: false
      subject: string;           // default: "Appointment Confirmed — {tenantName}"
      body: string;              // default: "Hi {name}, your appointment is confirmed for {date} at {time}."
    };
    newLeadAlert: {
      enabled: boolean;          // default: false
      recipients: string[];      // team email addresses
      subject: string;           // default: "New Lead: {name}"
      body: string;              // default: "A new lead was captured:\n\nName: {name}\nEmail: {email}\nChannel: {channel}"
    };
    conversationSummary: {
      enabled: boolean;          // default: false
      recipients: string[];      // team email addresses
    };
    followUp: {
      enabled: boolean;          // default: false
      delayHours: number;        // default: 24
      subject: string;           // default: "Thanks for chatting with {tenantName}!"
      body: string;              // customizable
    };
  };
  crmSync: {
    gohighlevel: {
      enabled: boolean;
      apiKey: string;            // encrypted
      locationId: string;
    };
    hubspot: {
      enabled: boolean;
      accessToken: string;       // encrypted, from OAuth
    };
  };
  customWebhooks: EventWebhookConfig[];  // existing webhook system
}
```

---

## 5. API Endpoints

### 5.1 Automations CRUD

```
GET  /api/v1/tenants/me/automations
  → Returns full automations config

PATCH /api/v1/tenants/me/automations/email/:type
  → Update a specific email automation (bookingConfirmation, newLeadAlert, etc.)
  Body: { enabled, subject?, body?, recipients?, delayHours? }

POST /api/v1/tenants/me/automations/email/:type/test
  → Send a test email with sample data
```

### 5.2 Onboarding Status (from previous spec)

```
GET /api/v1/tenants/me/onboarding-status
```

Add `automationsConfigured` to the checklist steps.

### 5.3 Skills + Available Tools (from previous spec)

Keep as designed — skills CRUD and available-tools endpoints.

---

## 6. Automation Engine

### 6.1 New File: `api/src/automations/automation.engine.ts`

```typescript
export class AutomationEngine {
  constructor(private emailService: EmailService) {}

  async process(event: WebhookEvent, tenant: Tenant): Promise<void> {
    const automations = tenant.settings?.automations;
    if (!automations) return;

    switch (event.type) {
      case 'appointment.booked':
        if (automations.emailNotifications?.bookingConfirmation?.enabled) {
          await this.sendBookingConfirmation(event, tenant);
        }
        break;

      case 'lead.created':
        if (automations.emailNotifications?.newLeadAlert?.enabled) {
          await this.sendNewLeadAlert(event, tenant);
        }
        break;

      case 'conversation.ended':
        if (automations.emailNotifications?.conversationSummary?.enabled) {
          await this.sendConversationSummary(event, tenant);
        }
        if (automations.emailNotifications?.followUp?.enabled) {
          await this.scheduleFollowUp(event, tenant);
        }
        break;
    }
  }
}
```

### 6.2 Integration Point

Called from `webhook.emitter.ts` — after checking external webhooks, also process internal automations:

```typescript
// In emitWebhookEvent():
// 1. Dispatch to external webhooks (existing)
// 2. Process internal automations (new)
await automationEngine.process(event, tenant);
```

---

## 7. Email Service

### 7.1 New File: `api/src/automations/email.service.ts`

```typescript
export class EmailService {
  private resend: Resend;

  constructor(apiKey: string) {
    this.resend = new Resend(apiKey);
  }

  async send(params: {
    to: string | string[];
    subject: string;
    body: string;
    from?: string;        // defaults to noreply@{configured domain}
    replyTo?: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    // Call Resend API
    // Log result
    // Return success/failure
  }
}
```

### 7.2 Template Rendering

```typescript
function renderTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => variables[key] || match);
}
```

### 7.3 Environment Config

```
RESEND_API_KEY=re_xxxxx           # Resend API key
EMAIL_FROM_DOMAIN=notifications.yourdomain.com  # verified domain in Resend
```

---

## 8. Portal — Automations Page

### 8.1 Route: `/settings/automations`

Replaces the "Event Webhooks" page as the primary post-conversation config page.

### 8.2 Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Automations                                                 │
│  Configure what happens after conversations                  │
│                                                              │
│  📧 EMAIL NOTIFICATIONS                                     │
│  ─────────────────────────────────────────────────────────── │
│                                                              │
│  ┌─ Booking Confirmation ────────────────────── [ON/OFF] ─┐ │
│  │ Send confirmation email to customer after booking       │ │
│  │ Subject: [Appointment Confirmed — {tenantName}       ]  │ │
│  │ Body:    [Hi {name}, your appointment is confirmed...]  │ │
│  │ Variables: {name} {email} {date} {time} {bookingId}     │ │
│  │                                    [Send Test Email]    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ New Lead Alert ──────────────────────────── [ON/OFF] ─┐ │
│  │ Notify your team when a new lead is captured            │ │
│  │ Recipients: [sarah@agency.com] [+ Add]                  │ │
│  │ Subject: [New Lead: {name}                           ]  │ │
│  │                                    [Send Test Email]    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Conversation Summary ────────────────────── [ON/OFF] ─┐ │
│  │ Email summary when a conversation ends                  │ │
│  │ Recipients: [team@agency.com] [+ Add]                   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Follow-up Email ─────────────────────────── [ON/OFF] ─┐ │
│  │ Send follow-up to customer after conversation           │ │
│  │ Delay: [24] hours after chat ends                       │ │
│  │ Subject: [Thanks for chatting with {tenantName}!     ]  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  🔗 CRM SYNC (Coming Soon)                                  │
│  ─────────────────────────────────────────────────────────── │
│  ☐ GoHighLevel     [Coming Soon]                            │
│  ☐ HubSpot         [Coming Soon]                            │
│                                                              │
│  ⚡ ADVANCED                                                 │
│  ─────────────────────────────────────────────────────────── │
│  Custom Webhooks: Send raw events to any URL                 │
│  [Configure Webhooks →]                                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 8.3 Components

- `AutomationsPage` — main page with sections
- `EmailAutomationCard` — reusable card for each email automation (toggle, template fields, test button)
- `RecipientInput` — tag-style email input for team recipients
- `TemplateEditor` — textarea with variable helper (shows available variables below)

---

## 9. New Files

### Backend

| File | Purpose |
|------|---------|
| `api/src/automations/automation.engine.ts` | Process events → run matching automations |
| `api/src/automations/email.service.ts` | Send emails via Resend API |
| `api/src/automations/template.ts` | Template variable rendering |
| `api/src/routes/automations.routes.ts` | Automations CRUD endpoints |
| Modify: `api/src/webhooks/webhook.emitter.ts` | Call automation engine after webhook dispatch |
| Modify: `api/src/config/environment.ts` | Add RESEND_API_KEY env var |
| Modify: `api/src/server.ts` | Mount automations routes, init email service |

### Frontend

| File | Purpose |
|------|---------|
| `portal/src/pages/settings/AutomationsSettings.tsx` | Main automations page |
| `portal/src/components/settings/EmailAutomationCard.tsx` | Reusable card component |
| `portal/src/components/settings/RecipientInput.tsx` | Tag-style email input |
| `portal/src/queries/useAutomationsQueries.ts` | React Query hooks |
| Modify: `portal/src/pages/settings/SettingsLayout.tsx` | Add Automations nav item |

---

## 10. Implementation Order

1. **Template renderer + tests** (pure function, no deps)
2. **Email service** (Resend SDK wrapper)
3. **Automation engine** (event → check config → send email)
4. **Wire into webhook emitter** (call engine after events)
5. **API endpoints** (automations CRUD)
6. **Portal page** (automations settings UI)
7. **Smart defaults** (auto-enable lead alert on signup)
8. **Onboarding checklist** (dashboard banner)

# Cal.com Booking Settings UI — Design Spec

## Goal

Add a Cal.com configuration card to Settings → Integrations so tenants can self-service connect their Cal.com account and enable AI-powered appointment booking. Minimize user input — just API key + pick an event type.

## User Flow

### Not Connected State

Card titled "Appointment Booking" with Cal.com branding. Shows:
- Description: "Connect Cal.com to let your chatbot book appointments"
- API Key input (password field with show/hide toggle)
- "Connect" button

### Connect Flow

1. User pastes Cal.com API key, clicks "Connect"
2. Single API call: `POST /tenants/me/integrations/calcom/connect` with `{ apiKey }`
3. Backend validates key against Cal.com, fetches event types, encrypts + stores key
4. **If invalid/expired key:** inline error "Invalid or expired API key"
5. **If no event types:** message "No event types found. Create one in Cal.com first."
6. **If success:** event type dropdown appears immediately

### Event Type Selection

- Dropdown shows event types: `"30 min Meeting (30 min)"` format (title + duration)
- Auto-selects if user has exactly one event type
- "Save" button stores the selection via `PATCH /tenants/me/integrations`
- On save, also auto-sets `webhookUrl` to `https://n8n-production-4e9b.up.railway.app/webhook/chatbot-platform` if currently null/empty

### Connected State

- Green "Connected" badge
- Selected event type name + duration displayed
- "Change" link to re-pick event type (shows dropdown inline)
- "Disconnect" button with confirmation dialog
- Disconnect removes Cal.com config (`PATCH /integrations` with `{ calcom: null }`) but does NOT touch webhookUrl

### Advanced Settings (collapsed by default)

- **Language** dropdown: en, nl, fr, de — defaults from tenant config or `en`
- **Collect fields** checkboxes: name (always on), email (always on), phone (optional), notes (optional)

## Backend Changes

### New Endpoint: `POST /tenants/me/integrations/calcom/connect`

```
Request:  { apiKey: string }
Response: { eventTypes: [{ id: number, title: string, length: number, slug: string }] }
Error:    { error: "Invalid or expired API key" } (401 from Cal.com)
          { error: "No event types found" } (empty list)
```

Implementation:
1. Validate `apiKey` is non-empty string
2. Call `GET https://api.cal.com/v2/event-types` with `Authorization: Bearer <apiKey>` and `cal-api-version: 2024-09-04`
3. If Cal.com returns 401 → return 400 with error message
4. If success but empty event types → return 400 with error message
5. Encrypt API key via `encrypt()`, store in `tenant.settings.integrations.calcom.apiKey`
6. Return event types list (id, title, length, slug)

Route: `integrations.routes.ts`, admin-only, under existing Clerk auth middleware.

### Existing Endpoint: `PATCH /tenants/me/integrations`

Already handles `{ calcom: { eventTypeId, language, collectFields } }`. No changes needed except:
- After saving Cal.com config with an `eventTypeId`, auto-set `tenant.webhookUrl` if currently null/empty
- Use hardcoded default: `https://n8n-production-4e9b.up.railway.app/webhook/chatbot-platform`
- Auto-generate `webhookSecret` if also null (existing logic in tenant PATCH)

### Disconnect

Existing: `PATCH /tenants/me/integrations` with `{ calcom: null }` removes the integration. No additional backend work.

## Frontend Components

### File: `portal/src/components/settings/CalcomSettings.tsx`

New component rendered inside `IntegrationTab.tsx` (or alongside it on the Integrations settings page).

**State machine:**
```
idle → connecting → pick_event_type → saving → connected
                 ↘ error (invalid key / no event types)
connected → disconnecting → idle
connected → changing → pick_event_type
```

**Queries/mutations:**
- `useIntegrations()` — GET current integrations state (existing query or add to tenantOptions)
- `useConnectCalcom()` — POST /calcom/connect mutation
- `useUpdateIntegrations()` — PATCH /integrations mutation (for saving event type + disconnect)

### UI Components Used

Follow existing patterns from IntegrationTab.tsx:
- Card (variant="glass"), CardHeader, CardContent
- Button, Input (type="password"), Label, Badge
- Select/dropdown for event types
- AlertDialog for disconnect confirmation
- Accordion for advanced settings
- Toast notifications via sonner

## Data Flow

```
[Not Connected]
  User enters API key → clicks Connect
  → POST /calcom/connect { apiKey }
  → Backend: Cal.com GET /v2/event-types → encrypt key → store → return event types
  → Frontend: show event type dropdown

[Pick Event Type]
  User selects event type → clicks Save
  → PATCH /integrations { calcom: { eventTypeId, language, collectFields } }
  → Backend: store config, auto-set webhookUrl if empty
  → Frontend: show connected state

[Connected]
  Change: re-show dropdown with current selection
  Disconnect: confirm dialog → PATCH /integrations { calcom: null } → back to idle

[Page Load]
  GET /integrations → if calcom.hasApiKey && calcom.eventTypeId → show connected state
  → if calcom.hasApiKey && !calcom.eventTypeId → show pick_event_type state
  → if !calcom → show idle state
```

## Edge Cases

- **Expired API key:** Connect returns clear error. Connected state does NOT actively poll Cal.com health — key validity is checked at connect time and at booking time (n8n tool call).
- **Only one event type:** Auto-select it, still show the dropdown in case user wants to see what's selected.
- **User rotates Cal.com key:** Disconnect → re-connect with new key.
- **Webhook URL already set:** Don't overwrite. Only auto-set when null/empty.
- **Multiple tenants same Cal.com account:** Supported — each tenant stores its own encrypted copy of the key.

## Testing

- Unit test for `POST /calcom/connect` endpoint (mock Cal.com API)
- Unit test for auto-set webhookUrl logic
- Existing integration tests for `PATCH /integrations` cover the rest

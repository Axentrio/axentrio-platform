# Canned Responses — Design Spec

## Overview

Pre-written message templates that agents can quickly insert during live chat conversations. Saves time, ensures consistency, and helps agents handle more concurrent chats.

## Decisions

- **Who can manage:** Admins create shared (team-wide) responses. Agents can create personal responses for themselves only.
- **Trigger mechanism:** Both slash commands (`/greet`) in chat input and a searchable dropdown picker.
- **Variable substitution:** Supports `{{customer_name}}`, `{{agent_name}}`, etc. Variables are resolved at insert time.
- **Organization:** Each response has one category + optional tags for cross-cutting labels.
- **Behavior on trigger:** Inserts text into the chat input for review/edit before sending. Not auto-sent.

## Data Model

### `CannedResponse` Entity

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUID | Primary key |
| `tenantId` | UUID | Multi-tenant scoping |
| `createdByUserId` | UUID, nullable | Who created it |
| `title` | varchar(100) | Display name, e.g. "Greeting" |
| `shortcut` | varchar(20) | Slash trigger, e.g. `/greet` |
| `content` | text | Message body, supports `{{variables}}` |
| `category` | varchar(50), nullable | e.g. "Billing", "Support" |
| `tags` | varchar[], default [] | Cross-cutting labels |
| `scope` | enum: `shared`, `personal` | Shared = team-wide, Personal = creator only |
| `usageCount` | int, default 0 | Tracks popularity |
| `isActive` | boolean, default true | Soft toggle |
| `createdAt` | timestamp | Auto |
| `updatedAt` | timestamp | Auto |

**Constraints:**
- `shortcut` unique per tenant for shared responses, unique per user for personal responses
- Indexed on `[tenantId, isActive]` and `[tenantId, scope]`

## API Endpoints

All routes under `/canned-responses`, protected by `requireClerkAuth, autoProvision, resolveTenantContext`.

| Method | Path | Access | Description |
|--------|------|--------|-------------|
| `GET` | `/` | All agents | List responses (shared + own personal). Supports `?search=`, `?category=`, `?scope=` |
| `GET` | `/:id` | All agents | Get single response |
| `POST` | `/` | Admin for shared, any agent for personal | Create response |
| `PATCH` | `/:id` | Admin for shared, owner for personal | Update response |
| `DELETE` | `/:id` | Admin for shared, owner for personal | Soft delete (set isActive=false) |
| `POST` | `/:id/use` | All agents | Increment usage count, return resolved content with variables substituted |

### Variable Substitution

The `/use` endpoint accepts a `variables` object and resolves placeholders:

```json
POST /canned-responses/:id/use
{
  "sessionId": "uuid",
  "variables": {
    "customer_name": "John",
    "agent_name": "Sarah"
  }
}
```

Returns the resolved content string. The portal inserts this into the chat input.

Built-in variables auto-resolved from session/agent context:
- `{{agent_name}}` — current agent's name
- `{{customer_name}}` — visitor name from session metadata (if available)

Custom variables in the template that aren't provided fall back to their placeholder text.

## Portal UI

### Management Page (`/canned-responses`)

- Table listing all accessible responses (shared + personal)
- Search bar + category filter dropdown + scope filter (shared/personal)
- Create/Edit modal with fields: title, shortcut, content (textarea), category (select/create), tags (multi-select/create), scope (shared/personal)
- Content textarea shows a preview with variable highlighting
- Delete confirmation via AlertDialog
- Badge showing "Shared" vs "Personal" scope
- Usage count displayed per response

### Chat Input Integration

- **Slash command detection:** When agent types `/` in chat input, show a filtered dropdown of matching responses. Typing `/gre` filters to responses with shortcuts starting with `gre`. Arrow keys to navigate, Enter to select.
- **Picker button:** An icon button next to the chat input opens a searchable modal/popover with all available responses organized by category. Click to select.
- **On selection:** The response content (with variables substituted) replaces the slash command text in the input. Agent can review/edit before sending.

## Testing

- Integration tests for CRUD endpoints (create, read, update, delete)
- Scope enforcement tests (agent can't edit shared responses, can't see other agents' personal responses)
- Variable substitution tests (built-in vars, custom vars, missing vars fallback)
- Shortcut uniqueness constraint tests

## Out of Scope

- Rich text / HTML in canned responses (plain text only for v1)
- Attachments or images in canned responses
- Analytics dashboard for response usage
- Import/export of response sets
- Response approval workflows

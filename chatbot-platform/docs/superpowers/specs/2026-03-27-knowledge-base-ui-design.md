# Knowledge Base UI Design Spec

## Overview

Portal UI for managing the RAG knowledge base feature. Provides document management, AI configuration, and stats — accessible to all roles with tiered permissions.

## Navigation

- **New sidebar item**: "Knowledge Base" with `BookOpen` icon (lucide-react)
- **Position**: between Analytics and Team
- **Route**: `/knowledge`
- **Visibility**: all authenticated roles (admin, supervisor, agent)
- **Page component**: `src/pages/KnowledgeBase.tsx`

## Page Structure

Tabbed layout using shadcn `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent` — same pattern as `Team.tsx`.

### Tab Visibility by Role

| Tab | Admin | Supervisor | Agent |
|-----|-------|------------|-------|
| Documents | Read + Write | Read only | Read only |
| AI Settings | Full control | Read only | Hidden |
| Overview | Full | Full | Read only |

## Tab 1: Documents

### Layout

Card grid in responsive columns: `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`.

### Document Card

Each card displays:
- **Top row**: document type icon (left), status badge + three-dot actions menu (right)
- **Title**: document name, font-weight 600
- **Metadata line**: type label, chunk count, relative timestamp (e.g. "PDF · 24 chunks · 2h ago")
- **Failed state**: additional inline error banner with message and "Retry" link

Document type icons:
- PDF: `FileText` icon or 📄
- DOCX: `FileText` icon or 📄
- Text: `FileEdit` icon or 📝
- FAQ: `HelpCircle` icon or ❓

Status badges:
- Indexed: green dot + "Indexed"
- Processing: yellow dot + "Processing"
- Pending: gray dot + "Pending"
- Failed: red dot + "Failed"

### Actions Menu (Admin only)

Three-dot dropdown per card:
- **Edit**: opens edit modal (title, content/re-upload)
- **Retry**: only shown for failed documents, re-queues ingestion
- **Delete**: confirmation dialog, then removes document + S3 object

### Top Bar

- **Left**: filter chips — All (default), PDF, DOCX, Text, FAQ. Active chip uses primary color, others use surface-2 background. Single-select, client-side filtering.
- **Right**: search input (filters cards by title, client-side) + "Add Document" button (admin only, primary color)

### Add Document Card

Last card in the grid (admin only): dashed border, centered "+" icon with "Drop file or click to add" text. Clicking opens the Add Document modal.

### Add Document Modal

Single modal using the project's `Modal` component wrapper:
- **Title**: "Add Document"
- **Type selector**: segmented control (shadcn `ToggleGroup` type="single") at top — Text, FAQ, PDF, DOCX
- **When Text or FAQ selected**:
  - Title input (required)
  - Content textarea (required, max 500K characters per backend validation)
- **When PDF or DOCX selected**:
  - Title input (required)
  - File upload zone: drag-and-drop area with click fallback, max 25MB, shows filename + size after selection
  - Upload flow: POST file to `/knowledge/documents/upload` to get upload token, then POST `/knowledge/documents` with the token
- **Footer**: Cancel + Create button with loading state

### Edit Document Modal

Same structure as Add, pre-populated with existing data. For file-based documents, shows current file info but allows re-upload. Save triggers reprocessing (increments processingVersion).

### Empty State

When no documents exist: centered layout with illustration/icon, "No documents yet" heading, description text, and "Add your first document" CTA button (admin) or "No documents have been added yet" (non-admin).

## Tab 2: AI Settings (Admin + Supervisor)

### Enable Toggle

Prominent `Switch` component at the top right of the tab header — "AI Bot Enabled". When disabled, all accordion sections below are visually dimmed (`opacity-50 pointer-events-none`).

### Accordion Sections

Using shadcn `Accordion` component (type="multiple" so multiple can be open).

#### Section 1: Provider Configuration

- **Provider**: radio group — OpenAI, Anthropic. Two styled buttons, active one uses primary color.
- **Model**: text input, placeholder "e.g. gpt-4o"
- **API Key**: password input. When a key exists, show "Key configured" indicator with a "Clear" button. When no key, show empty input. Key is encrypted on save.
- **Test Connection**: button that calls `POST /tenants/me/ai-settings/test` with a hardcoded sample question. Shows result inline: response text, confidence score, provider/model used. Loading state while testing.

#### Section 2: Brand Voice

- **Bot Name**: text input, placeholder "AI Assistant"
- **Tone**: `Select` dropdown — Formal, Casual, Friendly, Professional
- **Custom Instructions**: textarea, placeholder "Additional instructions for the AI..."
- **Greeting Message**: text input for the bot's first message

#### Section 3: Guardrails

- **Confidence Threshold**: shadcn `Slider` (0.0–1.0, step 0.05) with numeric value label
- **Max Response Length**: number input (characters)
- **Escalation Keywords**: tag input — type text + press Enter to add as a chip/badge, click X on chip to remove. Stored as string array.
- **Topics to Avoid**: same tag input pattern
- **Fallback Message**: textarea — sent when confidence is below threshold
- **Off-Hours Message**: textarea — sent outside business hours

### Save Behavior

Single "Save Settings" button at the bottom. Calls `PATCH /tenants/me/ai-settings` with all fields. Toast on success. Button shows loading spinner during save.

### Supervisor View

Same layout but all inputs are disabled/read-only. No Save button. Password field shows "Key configured" or "No key" without the actual value.

## Tab 3: Overview (Stats)

### Stat Cards

Top row: responsive grid `grid-cols-2 md:grid-cols-4`.

| Card | Value | Accent |
|------|-------|--------|
| Total Documents | number | none (default text) |
| Indexed | number | green left border |
| Processing | number | yellow left border |
| Failed | number, clickable | red left border, underlined — click navigates to Documents tab filtered to "failed" |

### Info Row

Below the stat cards, a single card with three columns:
- **Total Chunks**: number
- **KB Status**: badge (Active = green, Inactive = gray)
- **Last Indexed**: relative timestamp

### Data Source

`GET /knowledge/stats` via `useKnowledgeStats()` hook.

## Data Layer

### New File: `src/queries/useKnowledgeQueries.ts`

Following the established pattern in `useTenantQueries.ts`:

```typescript
// Query options
knowledgeOptions = {
  base: () => queryOptions({ queryKey, queryFn: GET /knowledge/base }),
  documents: () => queryOptions({ queryKey, queryFn: GET /knowledge/documents }),
  stats: () => queryOptions({ queryKey, queryFn: GET /knowledge/stats }),
}

// Hooks
useKnowledgeBase()
useKnowledgeDocuments()
useKnowledgeStats()

// Mutations
useCreateDocument()      // POST /knowledge/documents
useUpdateDocument()      // PUT /knowledge/documents/:id
useDeleteDocument()      // DELETE /knowledge/documents/:id
useRetryDocument()       // POST /knowledge/documents/:id/retry
useUploadFile()          // POST /knowledge/documents/upload
useUpdateAiSettings()    // PATCH /tenants/me/ai-settings
```

### Query Keys

Add to `src/queries/queryKeys.ts`:
```typescript
knowledge: {
  all: () => ['knowledge'],
  base: () => [...knowledge.all(), 'base'],
  documents: () => [...knowledge.all(), 'documents'],
  stats: () => [...knowledge.all(), 'stats'],
}
```

## Component Structure

```
src/pages/KnowledgeBase.tsx          — main page with tabs + role gating
src/pages/knowledge/
  DocumentsTab.tsx                   — card grid, filters, search
  DocumentCard.tsx                   — individual document card
  AddDocumentModal.tsx               — create/edit document modal
  AiSettingsTab.tsx                  — accordion sections + save
  TagInput.tsx                       — reusable tag/chip input for keywords
  OverviewTab.tsx                    — stat cards + info row
```

## Routing

In `App.tsx`, add inside the `ProtectedRoute` group (visible to all roles):
```tsx
<Route path="/knowledge" element={<KnowledgeBase />} />
```

## Sidebar

In `Sidebar.tsx`, add nav item:
```tsx
{ name: 'Knowledge Base', path: '/knowledge', icon: BookOpen }
```

Position after Analytics, before Team.

## Error & Loading States

- **Page loading**: `PageSkeleton` component (existing pattern)
- **Mutation loading**: button spinner via `Loader2` icon
- **API errors**: toast via Sonner for mutations, `InlineError` for query failures
- **Empty state**: per-tab empty states as described above
- **Optimistic updates**: not needed for v1 — document operations are async (ingestion queue), so immediate UI feedback isn't expected

## Styling Notes

- Follow existing Tailwind + CSS variable theme tokens (surface-0 through surface-4, primary colors, etc.)
- Cards use `bg-surface-2 rounded-xl` pattern
- Status colors: use existing `status-online` (green), `status-away` (yellow), `status-offline` (red) tokens where applicable
- Dark/light mode: all colors via CSS variables, no hardcoded values
- Responsive: stack to single column on mobile for card grids

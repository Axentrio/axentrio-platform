# Knowledge Base UI Polish Spec

## Overview

Polish pass on the existing Knowledge Base UI addressing critique findings. No new features — focused on UX improvements, deduplication, and visual consistency.

## 1. Unified Empty State

When both documents and AI settings are unconfigured, the main page shows a single onboarding flow instead of separate empty states.

### States

**A) No documents + AI not configured (first-time user)**

Centered on the main page (replaces the current document empty state):

- Heading: "Set up your Knowledge Base"
- Subtext: "Add documents and configure AI to start answering visitor questions automatically."
- Two step cards side by side:
  - Step 1: "Add your first document" — Upload icon, description, "Add Document" button (opens modal)
  - Step 2: "Configure AI" — Settings icon, description, "Set up AI" button (opens AI Settings slide-over)

**B) Documents exist + AI not configured**

Banner at top of documents grid (above filters):
- Yellow/amber tinted, single line: "AI bot is not configured — your documents won't be used until you set up a provider." + "Configure AI" link button that opens the slide-over.

**C) No documents + AI configured**

Current upload empty state (unchanged) — the centered "Upload PDFs, paste text, or add FAQs" with Add Document button.

**D) Both configured**

Normal view (unchanged).

### Detection Logic

- `hasDocuments`: `documents.length > 0`
- `hasAiConfigured`: `aiSettings?.enabled && aiSettings?.hasApiKey`

## 2. Filter Chips with Counts + Stat Binding

### Filter Chips

- Each filter chip shows its count: `All (3)`, `PDF (1)`, `TEXT (2)`
- Chips with 0 matching documents are hidden (except "All" which is always visible)
- Counts are derived client-side from the loaded documents array

### Two-Way Stat-Filter Binding

- Clicking a stat in the stats strip (e.g., "Failed") sets the document filter AND visually highlights that stat
- Clicking a filter chip activates it AND highlights the corresponding stat (if applicable — type filters don't have stats)
- The `docFilter` state drives both: stats strip highlights and filter chip active state
- Stat items that match the current filter get a ring/border highlight

### Implementation

- Rename `docFilter` to `activeFilter` for clarity
- Pass `activeFilter` down to stats strip for highlight state
- Stats strip `onClick` sets `activeFilter` to the status name (e.g., `'failed'`, `'processing'`)
- Filter chips include both type and status filters (merge the two lists)
- Merged filter list: `all`, `indexed`, `processing`, `failed`, `pdf`, `docx`, `text`, `faq` — with a visual separator between status and type groups

## 3. Remove Duplicate Add CTA

- The dashed "add document" card at the end of the grid is removed when `documents.length > 0`
- The toolbar "Add Document" button is sufficient
- When `documents.length === 0`, the empty state (section 1 above) handles the CTA

## 4. Move Test Chat to Main Header

- "Test Chat" button moves from inside the AI Settings slide-over to the main page header
- Positioned between "AI Settings" button and the page title area
- Same behavior: opens the TestChatPanel slide-over
- Disabled with tooltip when AI is not enabled
- Only visible to admin role

The AI Settings slide-over no longer renders the Test Chat button or the TestChatPanel — the main page handles it.

## 5. Minor Cleanup

### Extract timeAgo utility

- Create `portal/src/utils/timeAgo.ts` with the shared `timeAgo` function
- Remove duplicate implementations from `KnowledgeBase.tsx`, `DocumentCard.tsx`, and `OverviewTab.tsx`
- Import from the shared util

### Fix close button icon

- AI Settings slide-over close button: replace `&times;` HTML entity with `X` from lucide-react (consistent with TestChatPanel)

### Fix delete button color

- In DocumentsTab AlertDialog, replace `bg-status-offline` (gray) with `bg-red-500 hover:bg-red-600`

### Delete dead code

- Remove `portal/src/pages/knowledge/OverviewTab.tsx` — no longer imported since tab removal

### Move Reset AI Settings

- Remove the standalone "Reset AI Settings" ghost button from the bottom of AiSettingsTab
- Add it to a dropdown menu triggered by a `MoreVertical` icon button in the AI Settings slide-over header
- Dropdown contains: "Reset AI Settings" (red text) — same confirmation dialog

## Files Changed

```
Modified:
  portal/src/pages/KnowledgeBase.tsx           — unified empty state, stat-filter binding, test chat button
  portal/src/pages/knowledge/DocumentsTab.tsx  — filter counts, remove dashed card, banner state
  portal/src/pages/knowledge/DocumentCard.tsx   — import shared timeAgo
  portal/src/pages/knowledge/AiSettingsTab.tsx  — remove test chat button, move reset to dropdown

Created:
  portal/src/utils/timeAgo.ts                  — shared timeAgo utility

Deleted:
  portal/src/pages/knowledge/OverviewTab.tsx   — dead code (tabs removed)
```

# KB UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Knowledge Base UI based on design critique findings — unified empty states, filter counts with stat binding, deduplication, and visual consistency fixes.

**Architecture:** Frontend-only changes across existing KB components. No new endpoints or backend changes. Extract shared util, restructure empty states, add two-way filter-stat binding, clean up dead code and visual inconsistencies.

**Tech Stack:** React, TypeScript, Tailwind CSS, lucide-react.

**Spec:** `docs/superpowers/specs/2026-03-29-kb-ui-polish-design.md`

---

### Task 1: Extract shared timeAgo utility and delete dead code

**Files:**
- Create: `portal/src/utils/timeAgo.ts`
- Modify: `portal/src/pages/KnowledgeBase.tsx`
- Modify: `portal/src/pages/knowledge/DocumentCard.tsx`
- Delete: `portal/src/pages/knowledge/OverviewTab.tsx`

- [ ] **Step 1: Create shared timeAgo utility**

Create `chatbot-platform/portal/src/utils/timeAgo.ts`:

```typescript
export function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

- [ ] **Step 2: Update KnowledgeBase.tsx**

Remove the local `timeAgo` function (lines 141-150) and add import at top:

```typescript
import { timeAgo } from '@/utils/timeAgo';
```

- [ ] **Step 3: Update DocumentCard.tsx**

Remove the local `timeAgo` function (lines 42-50) and add import at top:

```typescript
import { timeAgo } from '@/utils/timeAgo';
```

- [ ] **Step 4: Delete OverviewTab.tsx**

```bash
rm chatbot-platform/portal/src/pages/knowledge/OverviewTab.tsx
```

- [ ] **Step 5: Commit**

```bash
git add chatbot-platform/portal/src/utils/timeAgo.ts chatbot-platform/portal/src/pages/KnowledgeBase.tsx chatbot-platform/portal/src/pages/knowledge/DocumentCard.tsx
git rm chatbot-platform/portal/src/pages/knowledge/OverviewTab.tsx
git commit -m "refactor: extract timeAgo utility, delete unused OverviewTab"
```

---

### Task 2: Filter chips with counts, merged status+type filters

**Files:**
- Modify: `portal/src/pages/knowledge/DocumentsTab.tsx`

- [ ] **Step 1: Add counts to filter chips and hide zero-count filters**

In `chatbot-platform/portal/src/pages/knowledge/DocumentsTab.tsx`, replace the filter chips section.

Replace the `typeFilters` and `statusFilters` constants at the top of the file:

```typescript
const allFilters = [
  { key: 'all', label: 'All', group: 'all' },
  { key: 'indexed', label: 'Indexed', group: 'status' },
  { key: 'processing', label: 'Processing', group: 'status' },
  { key: 'failed', label: 'Failed', group: 'status' },
  { key: 'pdf', label: 'PDF', group: 'type' },
  { key: 'docx', label: 'DOCX', group: 'type' },
  { key: 'text', label: 'Text', group: 'type' },
  { key: 'faq', label: 'FAQ', group: 'type' },
] as const;
```

Replace the filter chips JSX (the `<div className="flex gap-1.5 flex-wrap">` block) with:

```tsx
        <div className="flex gap-1.5 flex-wrap items-center">
          {allFilters.map((f) => {
            const count = f.key === 'all'
              ? documents.length
              : f.group === 'status'
                ? documents.filter((d: any) => d.status === f.key).length
                : documents.filter((d: any) => d.type === f.key).length;

            // Hide zero-count filters (except All)
            if (count === 0 && f.key !== 'all') return null;

            // Visual separator between status and type groups
            const isFirstType = f.key === 'pdf';

            return (
              <React.Fragment key={f.key}>
                {isFirstType && documents.some((d: any) => ['pdf','docx','text','faq'].includes(d.type)) && (
                  <div className="w-px h-4 bg-edge mx-0.5" />
                )}
                <button
                  onClick={() => setTypeFilter(f.key)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all duration-150 ${
                    typeFilter === f.key
                      ? 'bg-primary-500 text-white shadow-sm'
                      : 'bg-surface-2 text-text-muted hover:text-text-secondary hover:bg-surface-3'
                  }`}
                >
                  {f.label} ({count})
                </button>
              </React.Fragment>
            );
          })}
        </div>
```

Update the filtering logic in `useMemo` to use the unified filter list:

```typescript
  const filtered = useMemo(() => {
    let result = documents as any[];
    if (typeFilter !== 'all') {
      const statusKeys = ['indexed', 'processing', 'failed', 'pending'];
      const isStatus = statusKeys.includes(typeFilter);
      result = result.filter((d) =>
        isStatus ? d.status === typeFilter : d.type === typeFilter
      );
    }
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((d) => d.title.toLowerCase().includes(lower));
    }
    return result;
  }, [documents, typeFilter, search]);
```

- [ ] **Step 2: Remove old constants**

Remove these two lines from the top of the file:

```typescript
const typeFilters = ['all', 'pdf', 'docx', 'text', 'faq'] as const;
const statusFilters = ['failed', 'processing', 'pending', 'indexed'];
```

- [ ] **Step 3: Add React import for Fragment**

Ensure `React` is imported (it already is for `React.Fragment`).

- [ ] **Step 4: Commit**

```bash
git add chatbot-platform/portal/src/pages/knowledge/DocumentsTab.tsx
git commit -m "feat: filter chips with counts, merged status+type filters"
```

---

### Task 3: Two-way stat-filter binding

**Files:**
- Modify: `portal/src/pages/KnowledgeBase.tsx`

- [ ] **Step 1: Rename docFilter to activeFilter and pass it to stats strip**

In `chatbot-platform/portal/src/pages/KnowledgeBase.tsx`, rename `docFilter` to `activeFilter`:

```typescript
const [activeFilter, setActiveFilter] = useState<string | undefined>();
```

Update the stats strip to highlight the active stat. Replace the stat button's className:

```tsx
                <button
                  className={`flex items-center gap-2 px-2 py-1 rounded-lg transition-colors ${
                    stat.onClick ? 'hover:bg-surface-3 cursor-pointer' : 'cursor-default'
                  } ${activeFilter === stat.filterKey ? 'ring-1 ring-primary-500/40 bg-surface-3' : ''}`}
                  onClick={() => {
                    if (stat.onClick) {
                      stat.onClick();
                    }
                  }}
                  disabled={!stat.onClick}
                >
```

Add `filterKey` to each stat item:

```typescript
  const statItems = [
    { label: 'Total', value: total, icon: Database, color: 'text-primary-400', bg: 'bg-primary-400/10', filterKey: undefined },
    { label: 'Indexed', value: indexed, icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-400/10', filterKey: 'indexed', onClick: indexed > 0 ? () => setActiveFilter('indexed') : undefined },
    { label: 'Processing', value: processing, icon: Loader2, color: 'text-amber-400', bg: 'bg-amber-400/10', animate: processing > 0, filterKey: 'processing', onClick: processing > 0 ? () => setActiveFilter('processing') : undefined },
    { label: 'Failed', value: failed, icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-400/10', filterKey: 'failed', onClick: failed > 0 ? () => setActiveFilter('failed') : undefined },
  ];
```

Update the DocumentsTab prop:

```tsx
<DocumentsTab
  initialFilter={activeFilter}
  onFilterChange={(f) => setActiveFilter(f === 'all' ? undefined : f)}
/>
```

This creates two-way binding: stat clicks set `activeFilter` which flows down to DocumentsTab via `initialFilter`, and chip clicks flow back up via `onFilterChange`. Clicking "All" clears the highlight.

- [ ] **Step 2: Commit**

```bash
git add chatbot-platform/portal/src/pages/KnowledgeBase.tsx
git commit -m "feat: two-way stat-filter binding with visual highlight"
```

---

### Task 4: Remove duplicate add card, fix delete button color

**Files:**
- Modify: `portal/src/pages/knowledge/DocumentsTab.tsx`

- [ ] **Step 1: Remove dashed add card when documents exist**

In `chatbot-platform/portal/src/pages/knowledge/DocumentsTab.tsx`, remove the dashed "Add document" card from the grid. Find and delete this entire block inside the grid `<div>`:

```tsx
          {isAdmin && (
            <div
              onClick={() => setIsModalOpen(true)}
              className="border border-dashed border-edge rounded-xl flex items-center justify-center min-h-[140px] cursor-pointer hover:border-primary-500/50 hover:bg-primary-500/[0.02] transition-all duration-200 group/add"
            >
              <div className="text-center text-text-muted">
                <div className="p-2 rounded-lg bg-surface-2 group-hover/add:bg-primary-500/10 transition-colors mx-auto w-fit mb-2">
                  <Plus className="w-4 h-4 group-hover/add:text-primary-400 transition-colors" />
                </div>
                <p className="text-xs">Add document</p>
              </div>
            </div>
          )}
```

- [ ] **Step 2: Fix delete button color**

In the same file, find the AlertDialogAction for delete and replace:

```tsx
              className="bg-status-offline hover:bg-status-offline/90"
```

with:

```tsx
              className="bg-red-500 hover:bg-red-600"
```

- [ ] **Step 3: Commit**

```bash
git add chatbot-platform/portal/src/pages/knowledge/DocumentsTab.tsx
git commit -m "fix: remove duplicate add card, fix delete button color"
```

---

### Task 5: Move Test Chat to main header, fix AI Settings slide-over

**Files:**
- Modify: `portal/src/pages/KnowledgeBase.tsx`
- Modify: `portal/src/pages/knowledge/AiSettingsTab.tsx`

- [ ] **Step 1: Add Test Chat button and panel to KnowledgeBase.tsx**

In `chatbot-platform/portal/src/pages/KnowledgeBase.tsx`, add imports:

```typescript
import { BookOpen, Settings2, CheckCircle2, Loader2, AlertCircle, Database, Clock, MessageSquare, X } from 'lucide-react';
import { useGetAiSettings } from '@/queries/useKnowledgeQueries';
import TestChatPanel from './knowledge/TestChatPanel';
```

Add state and query after existing state:

```typescript
const [isTestChatOpen, setIsTestChatOpen] = useState(false);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { data: aiSettings } = useGetAiSettings() as { data: any };
const hasIndexedDocs = indexed > 0;
```

Add Test Chat button in the header, between AI Settings button and the title. Replace the header button group:

```tsx
          {isRole(['admin', 'supervisor']) && (
            <div className="flex items-center gap-2">
              {isRole('admin') && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setIsTestChatOpen(true)}
                  disabled={!aiSettings?.enabled}
                  title={!aiSettings?.enabled ? 'Enable AI bot first' : 'Test your AI bot'}
                  className="gap-1.5"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  Test Chat
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsSettingsOpen(true)}
                className="gap-1.5"
              >
                <Settings2 className="w-3.5 h-3.5" />
                AI Settings
              </Button>
            </div>
          )}
```

Fix the close button in the AI Settings slide-over — replace `&times;` with the X icon:

```tsx
              <Button variant="ghost" size="icon" onClick={() => setIsSettingsOpen(false)}>
                <X className="w-4 h-4" />
              </Button>
```

Add TestChatPanel render before the closing `</div>` of the component:

```tsx
      {isRole('admin') && (
        <TestChatPanel
          isOpen={isTestChatOpen}
          onClose={() => setIsTestChatOpen(false)}
          botName={aiSettings?.brandVoice?.name || 'AI Assistant'}
          provider={aiSettings?.provider || 'openai'}
          model={aiSettings?.model || ''}
          hasIndexedDocs={hasIndexedDocs}
        />
      )}
```

- [ ] **Step 2: Remove Test Chat from AiSettingsTab**

In `chatbot-platform/portal/src/pages/knowledge/AiSettingsTab.tsx`:

Remove `MessageSquare` from the lucide import.

Remove `TestChatPanel` import:
```typescript
import TestChatPanel from './TestChatPanel';
```

Remove `isTestChatOpen` state:
```typescript
const [isTestChatOpen, setIsTestChatOpen] = useState(false);
```

Remove the stats query and `hasIndexedDocs`:
```typescript
  const { data: stats } = useKnowledgeStats() as { data: any };
  const hasIndexedDocs = parseInt(stats?.documents?.indexed || '0') > 0;
```

Remove the `useKnowledgeStats` from the import:
```typescript
import { useGetAiSettings, useUpdateAiSettings, useTestAiSettings, useKnowledgeStats } from '@/queries/useKnowledgeQueries';
```
Change to:
```typescript
import { useGetAiSettings, useUpdateAiSettings, useTestAiSettings } from '@/queries/useKnowledgeQueries';
```

Remove the Test Chat button from the toggle section (the entire `{isAdmin && (<Button ... Test Chat ...>)}` block inside the header).

Remove the TestChatPanel render at the bottom of the component (the `{isAdmin && (<TestChatPanel ... />)}` block).

- [ ] **Step 3: Move Reset to dropdown in slide-over header**

In `chatbot-platform/portal/src/pages/knowledge/AiSettingsTab.tsx`, replace the Reset button section. Find:

```tsx
          <Button
            variant="ghost"
            size="sm"
            className="text-red-400 hover:text-red-400 hover:bg-red-400/10"
            onClick={() => setShowResetConfirm(true)}
          >
            Reset AI Settings
          </Button>
```

Replace with just the save button (remove the flex justify-between wrapper):

```tsx
      {isAdmin && (
        <div className="flex justify-end pt-4 pb-2">
          <Button onClick={handleSave} disabled={updateSettings.isPending} size="lg">
            {updateSettings.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Settings
          </Button>
        </div>
      )}
```

In `chatbot-platform/portal/src/pages/KnowledgeBase.tsx`, add the reset dropdown to the AI Settings slide-over header. Add imports:

```typescript
import { MoreVertical } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useUpdateAiSettings } from '@/queries/useKnowledgeQueries';
```

Add state:
```typescript
const [showResetConfirm, setShowResetConfirm] = useState(false);
const updateSettings = useUpdateAiSettings();
```

In the slide-over header, add a dropdown menu before the close button:

```tsx
              <div className="flex items-center gap-1">
                {isRole('admin') && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-7 w-7">
                        <MoreVertical className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => setShowResetConfirm(true)}
                        className="text-red-400"
                      >
                        Reset AI Settings
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                <Button variant="ghost" size="icon" onClick={() => setIsSettingsOpen(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
```

Add the reset confirmation dialog inside the slide-over, after the scrollable content div:

```tsx
            {/* Reset Confirmation */}
            <AlertDialog open={showResetConfirm} onOpenChange={setShowResetConfirm}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset AI Settings</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will disable the AI bot and clear all configuration. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-red-500 hover:bg-red-600"
                    onClick={() => {
                      updateSettings.mutate({
                        enabled: false,
                        apiKey: null,
                        brandVoice: { name: 'AI Assistant', tone: 'friendly', customInstructions: '' },
                        guardrails: {
                          greetingMessage: '',
                          confidenceThreshold: 0.7,
                          maxResponseLength: 500,
                          escalationKeywords: [],
                          topicsToAvoid: [],
                          fallbackMessage: '',
                          offHoursMessage: '',
                        },
                      });
                      setShowResetConfirm(false);
                    }}
                  >
                    Reset
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
```

- [ ] **Step 4: Remove reset dialog and related state/imports from AiSettingsTab**

In `chatbot-platform/portal/src/pages/knowledge/AiSettingsTab.tsx`:

Remove `showResetConfirm` state.

Remove the entire AlertDialog block for reset confirmation (lines 475-510).

Remove the AlertDialog imports (they're no longer used in this file).

- [ ] **Step 5: Commit**

```bash
git add chatbot-platform/portal/src/pages/KnowledgeBase.tsx chatbot-platform/portal/src/pages/knowledge/AiSettingsTab.tsx
git commit -m "feat: move Test Chat + Reset to main header, clean up AiSettingsTab"
```

---

### Task 6: Unified empty states

**Files:**
- Modify: `portal/src/pages/KnowledgeBase.tsx`
- Modify: `portal/src/pages/knowledge/DocumentsTab.tsx`

- [ ] **Step 1: Add AI config banner to DocumentsTab**

In `chatbot-platform/portal/src/pages/knowledge/DocumentsTab.tsx`, add a new prop and banner.

Update the interface:

```typescript
interface DocumentsTabProps {
  initialFilter?: string;
  onFilterChange?: (filter: string) => void;
  showAiBanner?: boolean;
  onConfigureAi?: () => void;
}
```

Update the component signature:

```typescript
const DocumentsTab: React.FC<DocumentsTabProps> = ({ initialFilter, onFilterChange, showAiBanner, onConfigureAi }) => {
```

Update the filter chip `onClick` to notify the parent:

```tsx
                  onClick={() => {
                    setTypeFilter(f.key);
                    onFilterChange?.(f.key);
                  }}
```

Add the banner just before the toolbar, inside the return:

```tsx
      {/* AI not configured banner */}
      {showAiBanner && onConfigureAi && (
        <div className="flex items-center justify-between p-3 rounded-lg bg-amber-400/5 border border-amber-400/10">
          <p className="text-xs text-amber-400/80">
            AI bot is not configured — documents won't be used for responses until you set up a provider.
          </p>
          <button
            onClick={onConfigureAi}
            className="text-xs font-medium text-amber-400 hover:text-amber-300 flex-shrink-0 ml-3"
          >
            Configure AI →
          </button>
        </div>
      )}
```

- [ ] **Step 2: Pass banner props from KnowledgeBase**

In `chatbot-platform/portal/src/pages/KnowledgeBase.tsx`, update the DocumentsTab usage.

First, add loading state checks. Destructure `isLoading` from both queries:

```typescript
const { data: stats, isLoading: statsLoading } = useKnowledgeStats() as { data: any; isLoading: boolean };
const { data: aiSettings, isLoading: aiLoading } = useGetAiSettings() as { data: any; isLoading: boolean };
```

Add a derived state for AI configured (matches spec):

```typescript
const hasAiConfigured = aiSettings?.enabled && aiSettings?.hasApiKey;
const queriesReady = !statsLoading && !aiLoading;
```

Update the DocumentsTab usage:

```tsx
        <DocumentsTab
          initialFilter={activeFilter}
          onFilterChange={(f) => setActiveFilter(f === 'all' ? undefined : f)}
          showAiBanner={queriesReady && total > 0 && !hasAiConfigured && isRole(['admin', 'supervisor'])}
          onConfigureAi={() => setIsSettingsOpen(true)}
        />
```

- [ ] **Step 3: Add unified first-time empty state**

In `chatbot-platform/portal/src/pages/KnowledgeBase.tsx`, add an `Upload` import:

```typescript
import { BookOpen, Settings2, CheckCircle2, Loader2, AlertCircle, Database, Clock, MessageSquare, X, MoreVertical, Upload } from 'lucide-react';
```

Before the stats strip, add a check for the unified empty state. After the header div and before the stats strip div, add:

```tsx
      {/* Unified first-time empty state — only after queries load */}
      {queriesReady && total === 0 && !hasAiConfigured && isRole('admin') && (
        <div className="px-6 pb-4">
          <div className="flex flex-col items-center text-center py-12">
            <div className="p-4 rounded-2xl bg-primary-500/5 mb-5">
              <BookOpen className="w-10 h-10 text-primary-400/60" />
            </div>
            <h2 className="text-lg font-semibold text-text-primary">Set up your Knowledge Base</h2>
            <p className="text-sm text-text-muted mt-2 max-w-md leading-relaxed">
              Add documents and configure AI to start answering visitor questions automatically.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-6 w-full max-w-lg">
              <button
                onClick={() => setShowAddDoc(true)}
                className="flex items-start gap-3 p-4 rounded-xl bg-surface-2 hover:bg-surface-3 transition-colors text-left"
              >
                <div className="p-2 rounded-lg bg-primary-500/10 flex-shrink-0">
                  <Upload className="w-4 h-4 text-primary-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Add your first document</p>
                  <p className="text-xs text-text-muted mt-0.5">Upload PDFs, paste text, or add FAQs</p>
                </div>
              </button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="flex items-start gap-3 p-4 rounded-xl bg-surface-2 hover:bg-surface-3 transition-colors text-left"
              >
                <div className="p-2 rounded-lg bg-primary-500/10 flex-shrink-0">
                  <Settings2 className="w-4 h-4 text-primary-400" />
                </div>
                <div>
                  <p className="text-sm font-medium text-text-primary">Configure AI</p>
                  <p className="text-xs text-text-muted mt-0.5">Choose provider, set brand voice</p>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
```

Add state for the add document trigger:

```typescript
const [showAddDoc, setShowAddDoc] = useState(false);
```

Import and render AddDocumentModal:

```typescript
import AddDocumentModal from './knowledge/AddDocumentModal';
```

Add before the closing `</div>`:

```tsx
      <AddDocumentModal
        isOpen={showAddDoc}
        onClose={() => setShowAddDoc(false)}
      />
```

Wrap the stats strip and documents section in a conditional so they only show when NOT in unified empty state:

```tsx
      {/* Only show stats + documents when not in unified empty state */}
      {!(queriesReady && total === 0 && !hasAiConfigured && isRole('admin')) && (
        <>
          {/* Stats Strip */}
          <div className="px-6 pb-4">
            ...existing stats strip...
          </div>

          {/* Documents */}
          <div className="px-6">
            <DocumentsTab ... />
          </div>
        </>
      )}
```

- [ ] **Step 4: Commit**

```bash
git add chatbot-platform/portal/src/pages/KnowledgeBase.tsx chatbot-platform/portal/src/pages/knowledge/DocumentsTab.tsx
git commit -m "feat: unified first-time empty state, AI config banner on documents"
```

---

### Task 7: Build verification

**Files:** None (verification only)

- [ ] **Step 1: TypeScript build**

```bash
cd chatbot-platform/portal && npx tsc --noEmit
```

Expected: no new errors from our changes.

- [ ] **Step 2: Manual smoke test**

1. Knowledge Base page loads with documents visible (no tabs)
2. Stats strip shows correct counts
3. Filter chips show counts, zero-count filters hidden
4. Clicking "Failed" stat highlights it and filters documents
5. "AI Settings" button opens slide-over with X close button
6. Reset is in the three-dot dropdown in slide-over header
7. "Test Chat" button in main header opens the test chat panel
8. For a tenant with no docs and no AI: unified onboarding shows two cards
9. For a tenant with docs but no AI: amber banner shows above documents

# Knowledge Base UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a portal UI for managing the RAG knowledge base — document management, AI settings, and stats — accessible to all roles with tiered permissions.

**Architecture:** New `/knowledge` route with tabbed page (Documents, AI Settings, Overview). Card grid for documents, accordion sections for AI settings, stat cards for overview. Data layer via react-query hooks calling existing backend API. Role-based UI gating via `useAppAuth().isRole()`.

**Tech Stack:** React, TypeScript, shadcn/ui (Tabs, Accordion, ToggleGroup, Card, Modal, etc.), TanStack Query, Tailwind CSS, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-03-27-knowledge-base-ui-design.md`

---

### Task 1: Add shadcn Accordion Component

**Files:**
- Create: `portal/src/components/ui/accordion.tsx`

- [ ] **Step 1: Install shadcn accordion**

```bash
cd chatbot-platform/portal && npx shadcn@latest add accordion
```

Expected: `src/components/ui/accordion.tsx` is created.

- [ ] **Step 2: Verify the file exists**

```bash
ls src/components/ui/accordion.tsx
```

Expected: file listed.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/accordion.tsx
git commit -m "feat: add shadcn accordion component"
```

---

### Task 2: Add Query Keys and Data Layer

**Files:**
- Modify: `portal/src/queries/queryKeys.ts`
- Create: `portal/src/queries/useKnowledgeQueries.ts`

- [ ] **Step 1: Add knowledge query keys**

In `portal/src/queries/queryKeys.ts`, add to the `queryKeys` object after the `analytics` key:

```typescript
  knowledge: {
    all: () => ['knowledge'] as const,
    base: () => [...queryKeys.knowledge.all(), 'base'] as const,
    documents: () => [...queryKeys.knowledge.all(), 'documents'] as const,
    stats: () => [...queryKeys.knowledge.all(), 'stats'] as const,
  },
```

- [ ] **Step 2: Create useKnowledgeQueries.ts**

Create `portal/src/queries/useKnowledgeQueries.ts`:

```typescript
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { api } from '../services/apiClient';
import { queryKeys } from './queryKeys';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// --- Query Options ---

export const knowledgeOptions = {
  base: () => queryOptions({
    queryKey: queryKeys.knowledge.base(),
    queryFn: () => api.get<Any>('/knowledge/base'),
  }),
  documents: () => queryOptions({
    queryKey: queryKeys.knowledge.documents(),
    queryFn: async () => {
      const res = await api.get<Any>('/knowledge/documents');
      return Array.isArray(res) ? res : res?.documents ?? [];
    },
  }),
  stats: () => queryOptions({
    queryKey: queryKeys.knowledge.stats(),
    queryFn: () => api.get<Any>('/knowledge/stats'),
  }),
};

// --- Query Hooks ---

export function useKnowledgeBase() {
  return useQuery(knowledgeOptions.base());
}

export function useKnowledgeDocuments() {
  return useQuery(knowledgeOptions.documents());
}

export function useKnowledgeStats() {
  return useQuery(knowledgeOptions.stats());
}

// --- Mutations ---

export function useCreateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { type: string; title: string; sourceContent?: string; uploadToken?: string; metadata?: Record<string, Any> }) =>
      api.post('/knowledge/documents', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success('Document created');
    },
    onError: () => toast.error('Failed to create document'),
  });
}

export function useUpdateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { title?: string; sourceContent?: string; metadata?: Record<string, Any> } }) =>
      api.put(`/knowledge/documents/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success('Document updated');
    },
    onError: () => toast.error('Failed to update document'),
  });
}

export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/knowledge/documents/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success('Document deleted');
    },
    onError: () => toast.error('Failed to delete document'),
  });
}

export function useRetryDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/knowledge/documents/${id}/retry`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.knowledge.stats() });
      toast.success('Document reprocessing started');
    },
    onError: () => toast.error('Failed to retry document'),
  });
}

export function useUploadFile() {
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return api.post<{ uploadToken: string }>('/knowledge/documents/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    },
    onError: () => toast.error('File upload failed'),
  });
}

export function useUpdateAiSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, Any>) =>
      api.patch('/tenants/me/ai-settings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      toast.success('AI settings saved');
    },
    onError: () => toast.error('Failed to save AI settings'),
  });
}

export function useGetAiSettings() {
  return useQuery({
    queryKey: [...queryKeys.tenants.me(), 'ai-settings'] as const,
    queryFn: () => api.get<Any>('/tenants/me/ai-settings'),
  });
}

export function useTestAiSettings() {
  return useMutation({
    mutationFn: (question: string) =>
      api.post<{ response: string; confidence: number; chunks: Any[]; provider: string; model: string }>('/tenants/me/ai-settings/test', { question }),
    onError: () => toast.error('Test failed'),
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add portal/src/queries/queryKeys.ts portal/src/queries/useKnowledgeQueries.ts
git commit -m "feat: add knowledge base query keys and data hooks"
```

---

### Task 3: Add Route and Sidebar Navigation

**Files:**
- Modify: `portal/src/App.tsx`
- Modify: `portal/src/components/Sidebar.tsx`
- Create: `portal/src/pages/KnowledgeBase.tsx` (stub)

- [ ] **Step 1: Create stub page component**

Create `portal/src/pages/KnowledgeBase.tsx`:

```tsx
import React from 'react';

const KnowledgeBase: React.FC = () => {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold text-text-primary">Knowledge Base</h1>
      <p className="text-text-secondary mt-1">Manage your AI bot's knowledge and configuration</p>
    </div>
  );
};

export default KnowledgeBase;
```

- [ ] **Step 2: Add route in App.tsx**

In `portal/src/App.tsx`, add the import near the other page imports:

```typescript
import KnowledgeBase from '@pages/KnowledgeBase';
```

Add the route inside the `<Route element={<ProtectedRoute />}>` group, after the Queue route and before the closing `</Route>`:

```tsx
<Route path="/knowledge" element={<KnowledgeBase />} />
```

- [ ] **Step 3: Add sidebar nav item**

In `portal/src/components/Sidebar.tsx`, add `BookOpen` to the lucide-react import:

```typescript
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  BarChart3,
  Building2,
  Settings,
  LogOut,
  Headphones,
  Shield,
  UserCog,
  TrendingUp,
  BookOpen,
} from 'lucide-react';
```

Add to the `menuItems` array, after the Analytics item and before Team:

```typescript
{ path: '/knowledge', label: 'Knowledge Base', icon: BookOpen, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
```

- [ ] **Step 4: Verify the page loads**

```bash
cd chatbot-platform/portal && npm run dev
```

Navigate to `http://localhost:4080/knowledge` — should see the stub heading. Sidebar should show "Knowledge Base" between Analytics and Team.

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/KnowledgeBase.tsx portal/src/App.tsx portal/src/components/Sidebar.tsx
git commit -m "feat: add Knowledge Base route and sidebar navigation"
```

---

### Task 4: Build Overview Tab (Stats)

**Files:**
- Create: `portal/src/pages/knowledge/OverviewTab.tsx`
- Modify: `portal/src/pages/KnowledgeBase.tsx`

- [ ] **Step 1: Create OverviewTab component**

Create `portal/src/pages/knowledge/OverviewTab.tsx`:

```tsx
import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useKnowledgeStats } from '@/queries/useKnowledgeQueries';
import { PageSkeleton } from '@/components/ui/page-skeleton';

interface OverviewTabProps {
  onNavigateToDocuments: (filter?: string) => void;
}

const OverviewTab: React.FC<OverviewTabProps> = ({ onNavigateToDocuments }) => {
  const { data: stats, isLoading } = useKnowledgeStats();

  if (isLoading) return <PageSkeleton />;

  const documents = stats?.documents || {};
  const indexed = parseInt(documents.indexed || '0');
  const processing = parseInt(documents.processing || '0');
  const failed = parseInt(documents.failed || '0');
  const pending = parseInt(documents.pending || '0');
  const total = indexed + processing + failed + pending;

  return (
    <div className="space-y-4 mt-4">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-5">
          <p className="text-sm text-text-muted mb-2">Total Documents</p>
          <p className="text-3xl font-bold text-text-primary">{total}</p>
        </Card>
        <Card className="p-5 border-l-4 border-l-status-online">
          <p className="text-sm text-text-muted mb-2">Indexed</p>
          <p className="text-3xl font-bold text-status-online">{indexed}</p>
        </Card>
        <Card className="p-5 border-l-4 border-l-status-away">
          <p className="text-sm text-text-muted mb-2">Processing</p>
          <p className="text-3xl font-bold text-status-away">{processing}</p>
        </Card>
        <Card className="p-5 border-l-4 border-l-status-offline">
          <p className="text-sm text-text-muted mb-2">Failed</p>
          <button
            onClick={() => onNavigateToDocuments('failed')}
            className="text-3xl font-bold text-status-offline underline hover:opacity-80"
          >
            {failed}
          </button>
        </Card>
      </div>

      {/* Info Row */}
      <Card className="p-5">
        <div className="grid grid-cols-3 gap-6">
          <div>
            <p className="text-sm text-text-muted mb-1">Total Chunks</p>
            <p className="text-lg font-semibold text-text-primary">{stats?.totalChunks || 0}</p>
          </div>
          <div>
            <p className="text-sm text-text-muted mb-1">KB Status</p>
            <Badge variant={stats?.status === 'active' ? 'default' : 'secondary'}>
              {stats?.status === 'active' ? 'Active' : 'Inactive'}
            </Badge>
          </div>
          <div>
            <p className="text-sm text-text-muted mb-1">Last Indexed</p>
            <p className="text-sm text-text-primary">
              {stats?.lastIndexedAt
                ? new Date(stats.lastIndexedAt).toLocaleString()
                : 'Never'}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default OverviewTab;
```

- [ ] **Step 2: Wire up the tabbed layout in KnowledgeBase.tsx**

Replace `portal/src/pages/KnowledgeBase.tsx` with:

```tsx
import React, { useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAppAuth } from '@/auth/useAppAuth';
import OverviewTab from './knowledge/OverviewTab';

const KnowledgeBase: React.FC = () => {
  const { isRole } = useAppAuth();
  const [activeTab, setActiveTab] = useState('documents');

  const handleNavigateToDocuments = (filter?: string) => {
    setActiveTab('documents');
    // Filter will be handled when DocumentsTab is built
  };

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Knowledge Base</h1>
          <p className="text-sm text-text-secondary mt-1">
            Manage your AI bot's knowledge and configuration
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          {isRole(['admin', 'supervisor']) && (
            <TabsTrigger value="ai-settings">AI Settings</TabsTrigger>
          )}
          <TabsTrigger value="overview">Overview</TabsTrigger>
        </TabsList>

        <TabsContent value="documents">
          <p className="text-text-muted mt-4">Documents tab — coming next.</p>
        </TabsContent>

        {isRole(['admin', 'supervisor']) && (
          <TabsContent value="ai-settings">
            <p className="text-text-muted mt-4">AI Settings tab — coming soon.</p>
          </TabsContent>
        )}

        <TabsContent value="overview">
          <OverviewTab onNavigateToDocuments={handleNavigateToDocuments} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default KnowledgeBase;
```

- [ ] **Step 3: Verify in browser**

Navigate to `http://localhost:4080/knowledge`, click "Overview" tab. Should show stat cards (values will be 0 if no documents exist yet).

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/knowledge/OverviewTab.tsx portal/src/pages/KnowledgeBase.tsx
git commit -m "feat: add Knowledge Base overview tab with stat cards"
```

---

### Task 5: Build Document Card Component

**Files:**
- Create: `portal/src/pages/knowledge/DocumentCard.tsx`

- [ ] **Step 1: Create DocumentCard component**

Create `portal/src/pages/knowledge/DocumentCard.tsx`:

```tsx
import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { FileText, FileEdit, HelpCircle, MoreVertical } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useAppAuth } from '@/auth/useAppAuth';

interface DocumentCardProps {
  document: {
    id: string;
    type: 'text' | 'faq' | 'pdf' | 'docx';
    title: string;
    status: 'pending' | 'processing' | 'indexed' | 'failed';
    chunkCount: number;
    errorMessage?: string | null;
    updatedAt: string;
  };
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
}

const typeIcons: Record<string, React.ElementType> = {
  pdf: FileText,
  docx: FileText,
  text: FileEdit,
  faq: HelpCircle,
};

const statusConfig: Record<string, { color: string; label: string }> = {
  indexed: { color: 'text-status-online', label: 'Indexed' },
  processing: { color: 'text-status-away', label: 'Processing' },
  pending: { color: 'text-text-muted', label: 'Pending' },
  failed: { color: 'text-status-offline', label: 'Failed' },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const DocumentCard: React.FC<DocumentCardProps> = ({ document, onEdit, onRetry, onDelete }) => {
  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin');
  const Icon = typeIcons[document.type] || FileText;
  const status = statusConfig[document.status] || statusConfig.pending;

  return (
    <Card className="p-4 hover:shadow-card-hover transition-shadow">
      <div className="flex justify-between items-start">
        <div className="p-2 bg-surface-2 rounded-xl">
          <Icon className="w-5 h-5 text-text-secondary" />
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${status.color}`}>● {status.label}</span>
          {isAdmin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <MoreVertical className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEdit}>Edit</DropdownMenuItem>
                {document.status === 'failed' && (
                  <DropdownMenuItem onClick={onRetry}>Retry</DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onDelete} className="text-status-offline">
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <h3 className="text-sm font-semibold text-text-primary mt-3 line-clamp-1">
        {document.title}
      </h3>
      <p className="text-xs text-text-muted mt-1">
        {document.type.toUpperCase()} · {document.chunkCount} chunks · {timeAgo(document.updatedAt)}
      </p>

      {document.status === 'failed' && document.errorMessage && (
        <div className="mt-3 p-2 bg-status-offline/10 rounded-lg">
          <p className="text-xs text-status-offline line-clamp-1">{document.errorMessage}</p>
          {isAdmin && (
            <button
              onClick={onRetry}
              className="text-xs text-status-offline underline mt-1"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </Card>
  );
};

export default DocumentCard;
```

- [ ] **Step 2: Commit**

```bash
git add portal/src/pages/knowledge/DocumentCard.tsx
git commit -m "feat: add DocumentCard component for knowledge base"
```

---

### Task 6: Build Add/Edit Document Modal

**Files:**
- Create: `portal/src/pages/knowledge/AddDocumentModal.tsx`

- [ ] **Step 1: Create AddDocumentModal component**

Create `portal/src/pages/knowledge/AddDocumentModal.tsx`:

```tsx
import React, { useState, useEffect, useRef } from 'react';
import { Modal } from '@/components/Modal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Loader2, Upload } from 'lucide-react';
import { useCreateDocument, useUpdateDocument, useUploadFile } from '@/queries/useKnowledgeQueries';

type DocType = 'text' | 'faq' | 'pdf' | 'docx';

interface AddDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingDocument?: {
    id: string;
    type: DocType;
    title: string;
    sourceContent?: string | null;
    storagePath?: string | null;
  } | null;
}

const AddDocumentModal: React.FC<AddDocumentModalProps> = ({ isOpen, onClose, editingDocument }) => {
  const isEditing = !!editingDocument;
  const [docType, setDocType] = useState<DocType>('text');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createDoc = useCreateDocument();
  const updateDoc = useUpdateDocument();
  const uploadFile = useUploadFile();

  const isSubmitting = createDoc.isPending || updateDoc.isPending || uploadFile.isPending;
  const isFileType = docType === 'pdf' || docType === 'docx';

  useEffect(() => {
    if (editingDocument) {
      setDocType(editingDocument.type);
      setTitle(editingDocument.title);
      setContent(editingDocument.sourceContent || '');
      setFile(null);
    } else {
      setDocType('text');
      setTitle('');
      setContent('');
      setFile(null);
    }
  }, [editingDocument, isOpen]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isEditing) {
      updateDoc.mutate(
        { id: editingDocument!.id, data: { title, sourceContent: isFileType ? undefined : content } },
        { onSuccess: onClose },
      );
      return;
    }

    if (isFileType && file) {
      const result = await uploadFile.mutateAsync(file);
      const token = (result as any)?.uploadToken;
      createDoc.mutate(
        { type: docType, title, uploadToken: token },
        { onSuccess: onClose },
      );
    } else {
      createDoc.mutate(
        { type: docType, title, sourceContent: content },
        { onSuccess: onClose },
      );
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped) setFile(dropped);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isEditing ? 'Edit Document' : 'Add Document'} size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        {!isEditing && (
          <div>
            <Label className="mb-2 text-text-secondary">Document Type</Label>
            <ToggleGroup
              type="single"
              value={docType}
              onValueChange={(val) => val && setDocType(val as DocType)}
              className="justify-start"
            >
              <ToggleGroupItem value="text">Text</ToggleGroupItem>
              <ToggleGroupItem value="faq">FAQ</ToggleGroupItem>
              <ToggleGroupItem value="pdf">PDF</ToggleGroupItem>
              <ToggleGroupItem value="docx">DOCX</ToggleGroupItem>
            </ToggleGroup>
          </div>
        )}

        <div>
          <Label className="mb-1 text-text-secondary">Title</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Document title"
            required
          />
        </div>

        {isFileType ? (
          <div>
            <Label className="mb-1 text-text-secondary">File</Label>
            <div
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-edge rounded-xl p-8 text-center cursor-pointer hover:border-primary-500 transition-colors"
            >
              {file ? (
                <div>
                  <p className="text-sm text-text-primary font-medium">{file.name}</p>
                  <p className="text-xs text-text-muted mt-1">
                    {(file.size / 1024 / 1024).toFixed(1)} MB
                  </p>
                </div>
              ) : (
                <div>
                  <Upload className="w-8 h-8 text-text-muted mx-auto mb-2" />
                  <p className="text-sm text-text-muted">
                    Drop a {docType.toUpperCase()} file here or click to browse
                  </p>
                  <p className="text-xs text-text-muted mt-1">Max 25MB</p>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={docType === 'pdf' ? '.pdf' : '.docx'}
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="hidden"
              />
            </div>
          </div>
        ) : (
          <div>
            <Label className="mb-1 text-text-secondary">Content</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={docType === 'faq' ? 'Q: Question here?\nA: Answer here.\n\nQ: Another question?\nA: Another answer.' : 'Paste your document content here...'}
              rows={10}
              required
            />
          </div>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting || (!isFileType && !content) || (isFileType && !file && !isEditing)}>
            {isSubmitting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isEditing ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default AddDocumentModal;
```

- [ ] **Step 2: Commit**

```bash
git add portal/src/pages/knowledge/AddDocumentModal.tsx
git commit -m "feat: add AddDocumentModal with type selector and file upload"
```

---

### Task 7: Build Documents Tab

**Files:**
- Create: `portal/src/pages/knowledge/DocumentsTab.tsx`
- Modify: `portal/src/pages/KnowledgeBase.tsx`

- [ ] **Step 1: Create DocumentsTab component**

Create `portal/src/pages/knowledge/DocumentsTab.tsx`:

```tsx
import React, { useState, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
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
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useAppAuth } from '@/auth/useAppAuth';
import { useKnowledgeDocuments, useDeleteDocument, useRetryDocument } from '@/queries/useKnowledgeQueries';
import DocumentCard from './DocumentCard';
import AddDocumentModal from './AddDocumentModal';

type DocType = 'text' | 'faq' | 'pdf' | 'docx';

const typeFilters = ['all', 'pdf', 'docx', 'text', 'faq'] as const;

interface DocumentsTabProps {
  initialFilter?: string;
}

const DocumentsTab: React.FC<DocumentsTabProps> = ({ initialFilter }) => {
  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin');
  const { data: documents = [], isLoading } = useKnowledgeDocuments();
  const deleteDoc = useDeleteDocument();
  const retryDoc = useRetryDocument();

  const [typeFilter, setTypeFilter] = useState<string>(initialFilter || 'all');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDoc, setEditingDoc] = useState<any>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = documents as any[];
    if (typeFilter !== 'all') {
      result = result.filter((d: any) => d.type === typeFilter || d.status === typeFilter);
    }
    if (search) {
      const lower = search.toLowerCase();
      result = result.filter((d: any) => d.title.toLowerCase().includes(lower));
    }
    return result;
  }, [documents, typeFilter, search]);

  if (isLoading) return <PageSkeleton />;

  const handleEdit = (doc: any) => {
    setEditingDoc(doc);
    setIsModalOpen(true);
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    setEditingDoc(null);
  };

  return (
    <div className="mt-4 space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row justify-between gap-3">
        <div className="flex gap-2 flex-wrap">
          {typeFilters.map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                typeFilter === f
                  ? 'bg-primary-500 text-white'
                  : 'bg-surface-2 text-text-muted hover:text-text-secondary'
              }`}
            >
              {f === 'all' ? 'All' : f.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-48"
          />
          {isAdmin && (
            <Button onClick={() => setIsModalOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add Document
            </Button>
          )}
        </div>
      </div>

      {/* Card Grid */}
      {filtered.length === 0 && !isLoading ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="p-4 bg-surface-2 rounded-2xl mb-4">
            <Plus className="w-8 h-8 text-text-muted" />
          </div>
          <h3 className="text-lg font-semibold text-text-primary">No documents yet</h3>
          <p className="text-sm text-text-muted mt-1 max-w-sm">
            {isAdmin
              ? 'Add your first document to start building your knowledge base.'
              : 'No documents have been added yet.'}
          </p>
          {isAdmin && (
            <Button className="mt-4" onClick={() => setIsModalOpen(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add your first document
            </Button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((doc: any) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              onEdit={() => handleEdit(doc)}
              onRetry={() => retryDoc.mutate(doc.id)}
              onDelete={() => setDeletingDocId(doc.id)}
            />
          ))}
          {isAdmin && (
            <Card
              onClick={() => setIsModalOpen(true)}
              className="border-2 border-dashed flex items-center justify-center min-h-[140px] cursor-pointer hover:border-primary-500 transition-colors"
            >
              <div className="text-center text-text-muted">
                <Plus className="w-6 h-6 mx-auto mb-2" />
                <p className="text-sm">Drop file or click to add</p>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Add/Edit Modal */}
      <AddDocumentModal
        isOpen={isModalOpen}
        onClose={handleCloseModal}
        editingDocument={editingDoc}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingDocId} onOpenChange={() => setDeletingDocId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Document</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this document and all its indexed chunks. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deletingDocId) deleteDoc.mutate(deletingDocId);
                setDeletingDocId(null);
              }}
              className="bg-status-offline hover:bg-status-offline/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default DocumentsTab;
```

- [ ] **Step 2: Wire DocumentsTab into KnowledgeBase.tsx**

In `portal/src/pages/KnowledgeBase.tsx`, add the import:

```typescript
import DocumentsTab from './knowledge/DocumentsTab';
```

Replace the Documents `TabsContent` placeholder:

```tsx
<TabsContent value="documents">
  <DocumentsTab initialFilter={activeTab === 'documents' ? undefined : undefined} />
</TabsContent>
```

- [ ] **Step 3: Verify in browser**

Navigate to `http://localhost:4080/knowledge`. Documents tab should show card grid (or empty state if no documents). Test the Add Document modal by clicking the button.

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/knowledge/DocumentsTab.tsx portal/src/pages/KnowledgeBase.tsx
git commit -m "feat: add Documents tab with card grid, filters, and CRUD modals"
```

---

### Task 8: Build TagInput Component

**Files:**
- Create: `portal/src/pages/knowledge/TagInput.tsx`

- [ ] **Step 1: Create TagInput component**

Create `portal/src/pages/knowledge/TagInput.tsx`:

```tsx
import React, { useState, KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}

const TagInput: React.FC<TagInputProps> = ({ value, onChange, placeholder, disabled }) => {
  const [input, setInput] = useState('');

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && input.trim()) {
      e.preventDefault();
      const tag = input.trim();
      if (!value.includes(tag)) {
        onChange([...value, tag]);
      }
      setInput('');
    }
    if (e.key === 'Backspace' && !input && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeTag = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
  };

  return (
    <div className="flex flex-wrap gap-1.5 p-2 border border-edge rounded-lg bg-surface-0 min-h-[42px]">
      {value.map((tag) => (
        <Badge key={tag} variant="secondary" className="gap-1 pr-1">
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="hover:text-text-primary"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </Badge>
      ))}
      {!disabled && (
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ''}
          className="border-0 shadow-none focus-visible:ring-0 p-0 h-6 min-w-[100px] flex-1"
          disabled={disabled}
        />
      )}
    </div>
  );
};

export default TagInput;
```

- [ ] **Step 2: Commit**

```bash
git add portal/src/pages/knowledge/TagInput.tsx
git commit -m "feat: add TagInput component for keyword chips"
```

---

### Task 9: Build AI Settings Tab

**Files:**
- Create: `portal/src/pages/knowledge/AiSettingsTab.tsx`
- Modify: `portal/src/pages/KnowledgeBase.tsx`

- [ ] **Step 1: Create AiSettingsTab component**

Create `portal/src/pages/knowledge/AiSettingsTab.tsx`:

```tsx
import React, { useState, useEffect } from 'react';
import { Loader2, FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { useAppAuth } from '@/auth/useAppAuth';
import { useGetAiSettings, useUpdateAiSettings, useTestAiSettings } from '@/queries/useKnowledgeQueries';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import TagInput from './TagInput';

const AiSettingsTab: React.FC = () => {
  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin');
  const { data: aiSettings, isLoading } = useGetAiSettings();
  const updateSettings = useUpdateAiSettings();
  const testSettings = useTestAiSettings();

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<'openai' | 'anthropic'>('openai');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasExistingKey, setHasExistingKey] = useState(false);
  const [botName, setBotName] = useState('');
  const [tone, setTone] = useState('friendly');
  const [customInstructions, setCustomInstructions] = useState('');
  const [greetingMessage, setGreetingMessage] = useState('');
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.7);
  const [maxResponseLength, setMaxResponseLength] = useState(500);
  const [escalationKeywords, setEscalationKeywords] = useState<string[]>([]);
  const [topicsToAvoid, setTopicsToAvoid] = useState<string[]>([]);
  const [fallbackMessage, setFallbackMessage] = useState('');
  const [offHoursMessage, setOffHoursMessage] = useState('');
  const [testResult, setTestResult] = useState<any>(null);

  useEffect(() => {
    if (aiSettings) {
      setEnabled(aiSettings.enabled ?? false);
      setProvider(aiSettings.provider ?? 'openai');
      setModel(aiSettings.model ?? '');
      setHasExistingKey(aiSettings.hasApiKey ?? false);
      setBotName(aiSettings.brandVoice?.name ?? '');
      setTone(aiSettings.brandVoice?.tone ?? 'friendly');
      setCustomInstructions(aiSettings.brandVoice?.customInstructions ?? '');
      setGreetingMessage(aiSettings.guardrails?.greetingMessage ?? '');
      setConfidenceThreshold(aiSettings.guardrails?.confidenceThreshold ?? 0.7);
      setMaxResponseLength(aiSettings.guardrails?.maxResponseLength ?? 500);
      setEscalationKeywords(aiSettings.guardrails?.escalationKeywords ?? []);
      setTopicsToAvoid(aiSettings.guardrails?.topicsToAvoid ?? []);
      setFallbackMessage(aiSettings.guardrails?.fallbackMessage ?? '');
      setOffHoursMessage(aiSettings.guardrails?.offHoursMessage ?? '');
    }
  }, [aiSettings]);

  const handleSave = () => {
    updateSettings.mutate({
      enabled,
      provider,
      model,
      ...(apiKey ? { apiKey } : {}),
      brandVoice: {
        name: botName,
        tone,
        customInstructions,
      },
      guardrails: {
        greetingMessage,
        confidenceThreshold,
        maxResponseLength,
        escalationKeywords,
        topicsToAvoid,
        fallbackMessage,
        offHoursMessage,
      },
    });
  };

  const handleTest = () => {
    setTestResult(null);
    testSettings.mutate('What are your return policies?', {
      onSuccess: (data) => setTestResult(data),
    });
  };

  if (isLoading) return <PageSkeleton />;

  const readOnly = !isAdmin;

  return (
    <div className="mt-4 space-y-4">
      {/* Enable toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-text-primary">AI Bot</p>
          <p className="text-xs text-text-muted">Enable AI-powered responses for visitors</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={readOnly} />
      </div>

      <div className={enabled ? '' : 'opacity-50 pointer-events-none'}>
        <Accordion type="multiple" defaultValue={['provider']} className="space-y-2">
          {/* Provider Configuration */}
          <AccordionItem value="provider" className="border rounded-xl px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <span className="flex items-center gap-2">⚙️ Provider Configuration</span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pb-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="mb-2 text-text-secondary">Provider</Label>
                  <div className="flex gap-2">
                    {(['openai', 'anthropic'] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => !readOnly && setProvider(p)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          provider === p
                            ? 'bg-primary-500 text-white'
                            : 'bg-surface-2 text-text-muted'
                        }`}
                      >
                        {p === 'openai' ? 'OpenAI' : 'Anthropic'}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <Label className="mb-2 text-text-secondary">Model</Label>
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="e.g. gpt-4o"
                    disabled={readOnly}
                  />
                </div>
              </div>

              <div>
                <Label className="mb-2 text-text-secondary">API Key</Label>
                {readOnly ? (
                  <p className="text-sm text-text-muted">
                    {hasExistingKey ? '✓ Key configured' : 'No key configured'}
                  </p>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={hasExistingKey ? '••••••••••••' : 'Enter API key'}
                      />
                      {hasExistingKey && (
                        <Button
                          variant="outline"
                          onClick={() => { setApiKey(''); setHasExistingKey(false); }}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                    {hasExistingKey && !apiKey && (
                      <p className="text-xs text-status-online mt-1">✓ Key configured</p>
                    )}
                  </>
                )}
              </div>

              {isAdmin && (
                <div>
                  <Button variant="outline" size="sm" onClick={handleTest} disabled={testSettings.isPending}>
                    {testSettings.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <FlaskConical className="w-4 h-4 mr-2" />
                    )}
                    Test Connection
                  </Button>
                  {testResult && (
                    <Card className="mt-3 p-3 space-y-2">
                      <p className="text-sm text-text-primary">{testResult.response}</p>
                      <div className="flex gap-3 text-xs text-text-muted">
                        <span>Confidence: {(testResult.confidence * 100).toFixed(0)}%</span>
                        <span>{testResult.provider} / {testResult.model}</span>
                        <span>{testResult.chunks?.length || 0} chunks used</span>
                      </div>
                    </Card>
                  )}
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* Brand Voice */}
          <AccordionItem value="brand-voice" className="border rounded-xl px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <span className="flex items-center gap-2">🎙️ Brand Voice</span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pb-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="mb-1 text-text-secondary">Bot Name</Label>
                  <Input
                    value={botName}
                    onChange={(e) => setBotName(e.target.value)}
                    placeholder="AI Assistant"
                    disabled={readOnly}
                  />
                </div>
                <div>
                  <Label className="mb-1 text-text-secondary">Tone</Label>
                  <Select value={tone} onValueChange={setTone} disabled={readOnly}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="formal">Formal</SelectItem>
                      <SelectItem value="casual">Casual</SelectItem>
                      <SelectItem value="friendly">Friendly</SelectItem>
                      <SelectItem value="professional">Professional</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">Custom Instructions</Label>
                <Textarea
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  placeholder="Additional instructions for the AI..."
                  rows={3}
                  disabled={readOnly}
                />
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">Greeting Message</Label>
                <Input
                  value={greetingMessage}
                  onChange={(e) => setGreetingMessage(e.target.value)}
                  placeholder="Hi! How can I help you today?"
                  disabled={readOnly}
                />
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Guardrails */}
          <AccordionItem value="guardrails" className="border rounded-xl px-4">
            <AccordionTrigger className="text-sm font-semibold">
              <span className="flex items-center gap-2">🛡️ Guardrails</span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pb-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="mb-2 text-text-secondary">
                    Confidence Threshold: {confidenceThreshold.toFixed(2)}
                  </Label>
                  <Slider
                    value={[confidenceThreshold]}
                    onValueChange={([v]) => setConfidenceThreshold(v)}
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={readOnly}
                  />
                </div>
                <div>
                  <Label className="mb-1 text-text-secondary">Max Response Length</Label>
                  <Input
                    type="number"
                    value={maxResponseLength}
                    onChange={(e) => setMaxResponseLength(parseInt(e.target.value) || 0)}
                    disabled={readOnly}
                  />
                </div>
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">Escalation Keywords</Label>
                <TagInput
                  value={escalationKeywords}
                  onChange={setEscalationKeywords}
                  placeholder="Type a keyword and press Enter..."
                  disabled={readOnly}
                />
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">Topics to Avoid</Label>
                <TagInput
                  value={topicsToAvoid}
                  onChange={setTopicsToAvoid}
                  placeholder="Type a topic and press Enter..."
                  disabled={readOnly}
                />
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">Fallback Message</Label>
                <Textarea
                  value={fallbackMessage}
                  onChange={(e) => setFallbackMessage(e.target.value)}
                  placeholder="I'm connecting you to a human agent..."
                  rows={2}
                  disabled={readOnly}
                />
              </div>
              <div>
                <Label className="mb-1 text-text-secondary">Off-Hours Message</Label>
                <Textarea
                  value={offHoursMessage}
                  onChange={(e) => setOffHoursMessage(e.target.value)}
                  placeholder="We're currently outside business hours..."
                  rows={2}
                  disabled={readOnly}
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {isAdmin && (
        <div className="flex justify-end pt-2">
          <Button onClick={handleSave} disabled={updateSettings.isPending}>
            {updateSettings.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Save Settings
          </Button>
        </div>
      )}
    </div>
  );
};

export default AiSettingsTab;
```

- [ ] **Step 2: Wire AiSettingsTab into KnowledgeBase.tsx**

In `portal/src/pages/KnowledgeBase.tsx`, add the import:

```typescript
import AiSettingsTab from './knowledge/AiSettingsTab';
```

Replace the AI Settings `TabsContent` placeholder:

```tsx
{isRole(['admin', 'supervisor']) && (
  <TabsContent value="ai-settings">
    <AiSettingsTab />
  </TabsContent>
)}
```

- [ ] **Step 3: Verify in browser**

Navigate to `http://localhost:4080/knowledge`, click "AI Settings" tab. Should show the enable toggle and three accordion sections. Test expanding/collapsing, toggling provider buttons, and the slider.

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/knowledge/AiSettingsTab.tsx portal/src/pages/KnowledgeBase.tsx
git commit -m "feat: add AI Settings tab with accordion sections and save"
```

---

### Task 10: Cross-Tab Navigation and Polish

**Files:**
- Modify: `portal/src/pages/KnowledgeBase.tsx`
- Modify: `portal/src/pages/knowledge/DocumentsTab.tsx`

- [ ] **Step 1: Wire up failed-count click to navigate to Documents tab with filter**

In `portal/src/pages/KnowledgeBase.tsx`, add state for document filter and pass it through:

Ensure the imports at the top of the file include all three tab components:

```typescript
import DocumentsTab from './knowledge/DocumentsTab';
import AiSettingsTab from './knowledge/AiSettingsTab';
import OverviewTab from './knowledge/OverviewTab';
```

Then replace the existing component body with:

```tsx
const KnowledgeBase: React.FC = () => {
  const { isRole } = useAppAuth();
  const [activeTab, setActiveTab] = useState('documents');
  const [docFilter, setDocFilter] = useState<string | undefined>();

  const handleNavigateToDocuments = (filter?: string) => {
    setDocFilter(filter);
    setActiveTab('documents');
  };

  // Clear filter when manually switching tabs
  const handleTabChange = (tab: string) => {
    if (tab !== 'documents') setDocFilter(undefined);
    setActiveTab(tab);
  };

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Knowledge Base</h1>
          <p className="text-sm text-text-secondary mt-1">
            Manage your AI bot's knowledge and configuration
          </p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
        <TabsList>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          {isRole(['admin', 'supervisor']) && (
            <TabsTrigger value="ai-settings">AI Settings</TabsTrigger>
          )}
          <TabsTrigger value="overview">Overview</TabsTrigger>
        </TabsList>

        <TabsContent value="documents">
          <DocumentsTab initialFilter={docFilter} />
        </TabsContent>

        {isRole(['admin', 'supervisor']) && (
          <TabsContent value="ai-settings">
            <AiSettingsTab />
          </TabsContent>
        )}

        <TabsContent value="overview">
          <OverviewTab onNavigateToDocuments={handleNavigateToDocuments} />
        </TabsContent>
      </Tabs>
    </div>
  );
};
```

- [ ] **Step 2: Make DocumentsTab respond to initialFilter changes**

In `portal/src/pages/knowledge/DocumentsTab.tsx`, add a `useEffect` to sync the filter:

After the existing `useState` for `typeFilter`, add:

```typescript
useEffect(() => {
  if (initialFilter) setTypeFilter(initialFilter);
}, [initialFilter]);
```

- [ ] **Step 3: Verify cross-tab navigation**

In the browser, go to Overview tab, click the failed count number. Should switch to Documents tab filtered to show only failed documents.

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/KnowledgeBase.tsx portal/src/pages/knowledge/DocumentsTab.tsx
git commit -m "feat: wire up cross-tab navigation and document filter sync"
```

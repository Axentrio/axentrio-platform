import React, { useState, useMemo } from 'react';
import { Plus, Search, Pencil, Trash2 } from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import {
  useCannedResponses,
  useCreateCannedResponse,
  useUpdateCannedResponse,
  useDeleteCannedResponse,
} from '../queries/useCannedResponseQueries';
import type { CannedResponse } from '../queries/useCannedResponseQueries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { toast } from 'sonner';

interface FormData {
  title: string;
  shortcut: string;
  content: string;
  category: string;
  tags: string;
  scope: 'shared' | 'personal';
}

const emptyForm: FormData = {
  title: '',
  shortcut: '',
  content: '',
  category: '',
  tags: '',
  scope: 'personal',
};

export const CannedResponsesContent: React.FC = () => {
  const { user } = useAppAuth();
  const isAdmin = user && ['admin', 'supervisor', 'super_admin'].includes(user.role);

  const { data, isLoading, error } = useCannedResponses();
  const createMutation = useCreateCannedResponse();
  const updateMutation = useUpdateCannedResponse();
  const deleteMutation = useDeleteCannedResponse();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [scopeFilter, setScopeFilter] = useState('all');
  const [form, setForm] = useState<FormData>(emptyForm);

  const responses: CannedResponse[] = data?.data ?? [];

  const categories = useMemo(() => {
    const cats = new Set(responses.map((r) => r.category).filter(Boolean));
    return Array.from(cats) as string[];
  }, [responses]);

  const filtered = useMemo(() => {
    let result = responses;
    if (categoryFilter !== 'all') {
      result = result.filter((r) => r.category === categoryFilter);
    }
    if (scopeFilter !== 'all') {
      result = result.filter((r) => r.scope === scopeFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.shortcut.toLowerCase().includes(q) ||
          r.content.toLowerCase().includes(q)
      );
    }
    return result;
  }, [responses, categoryFilter, scopeFilter, search]);

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setIsModalOpen(true);
  };

  const openEdit = (cr: CannedResponse) => {
    setEditingId(cr.id);
    setForm({
      title: cr.title,
      shortcut: cr.shortcut,
      content: cr.content,
      category: cr.category ?? '',
      tags: cr.tags.join(', '),
      scope: cr.scope,
    });
    setIsModalOpen(true);
  };

  const handleSubmit = async () => {
    const payload = {
      title: form.title,
      shortcut: form.shortcut,
      content: form.content,
      category: form.category || undefined,
      tags: form.tags ? form.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      scope: form.scope,
    };

    try {
      if (editingId) {
        await updateMutation.mutateAsync({ id: editingId, ...payload });
        toast.success('Canned response updated');
      } else {
        await createMutation.mutateAsync(payload);
        toast.success('Canned response created');
      }
      setIsModalOpen(false);
    } catch {
      toast.error(editingId ? 'Failed to update' : 'Failed to create');
    }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    try {
      await deleteMutation.mutateAsync(deletingId);
      toast.success('Canned response deleted');
    } catch {
      toast.error('Failed to delete');
    }
    setDeletingId(null);
  };

  if (isLoading) return <PageSkeleton variant="list" rows={6} />;
  if (error) return <InlineError message="Failed to load canned responses" />;

  return (
    <div className="space-y-6">
      {/* New Response button + Filters */}
      <div className="flex items-center justify-between">
        <div />
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-2" /> New Response
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
          <Input
            placeholder="Search responses..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Scope" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="shared">Shared</SelectItem>
            <SelectItem value="personal">Personal</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-edge overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead className="hidden md:table-cell">Content</TableHead>
              <TableHead>Shortcut</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead className="text-right">Used</TableHead>
              <TableHead className="w-[100px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-12">
                  <div className="flex flex-col items-center gap-3">
                    <p className="text-text-muted">
                      {responses.length === 0
                        ? 'No canned responses yet'
                        : 'No responses match your filters'}
                    </p>
                    {responses.length === 0 && (
                      <Button variant="outline" size="sm" onClick={openCreate}>
                        <Plus className="w-4 h-4 mr-2" /> Create your first response
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((cr) => (
                <TableRow key={cr.id}>
                  <TableCell>
                    <div className="font-medium">{cr.title}</div>
                    {cr.tags.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {cr.tags.map((tag) => (
                          <span key={tag} className="text-[10px] px-1.5 py-0.5 bg-surface-3 text-text-muted rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <p className="text-sm text-text-secondary truncate max-w-[300px]">{cr.content}</p>
                  </TableCell>
                  <TableCell>
                    <code className="text-xs bg-surface-3 px-1.5 py-0.5 rounded">/{cr.shortcut}</code>
                  </TableCell>
                  <TableCell>{cr.category ?? '—'}</TableCell>
                  <TableCell>
                    <Badge variant={cr.scope === 'shared' ? 'default' : 'secondary'}>
                      {cr.scope}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{cr.usageCount}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1 justify-end">
                      <Button variant="ghost" size="icon" onClick={() => openEdit(cr)} aria-label={`Edit ${cr.title}`}>
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeletingId(cr.id)} aria-label={`Delete ${cr.title}`}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create/Edit Modal */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Edit' : 'New'} Canned Response</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. Greeting"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shortcut">Shortcut</Label>
              <div className="flex items-center gap-2">
                <span className="text-text-muted">/</span>
                <Input
                  id="shortcut"
                  value={form.shortcut}
                  onChange={(e) => setForm({ ...form, shortcut: e.target.value })}
                  placeholder="e.g. greet"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="content">Content</Label>
              <Textarea
                id="content"
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
                placeholder="Hello {{customer_name}}, how can I help?"
                rows={4}
              />
              <p className="text-xs text-text-muted">
                Available variables: <code className="bg-surface-3 px-1 rounded">{'{{agent_name}}'}</code> <code className="bg-surface-3 px-1 rounded">{'{{customer_name}}'}</code> — or add your own like <code className="bg-surface-3 px-1 rounded">{'{{order_id}}'}</code>
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Input
                  id="category"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="e.g. General"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="scope">Scope</Label>
                <Select
                  value={form.scope}
                  onValueChange={(v) => setForm({ ...form, scope: v as 'shared' | 'personal' })}
                  disabled={!isAdmin && form.scope === 'shared'}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {isAdmin && <SelectItem value="shared">Shared</SelectItem>}
                    <SelectItem value="personal">Personal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="tags">Tags</Label>
              <Input
                id="tags"
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="billing, refund, common (comma-separated)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsModalOpen(false)}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={!form.title || !form.shortcut || !form.content || createMutation.isPending || updateMutation.isPending}
            >
              {(createMutation.isPending || updateMutation.isPending) ? 'Saving...' : editingId ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete canned response?</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const target = responses.find((r) => r.id === deletingId);
                return target
                  ? `"${target.title}" (/${target.shortcut}) will be removed. This action cannot be undone.`
                  : 'This will remove the response. This action cannot be undone.';
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

const CannedResponses: React.FC = () => {
  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Canned Responses</h1>
          <p className="text-sm text-text-secondary mt-1">
            Pre-written message templates for quick replies
          </p>
        </div>
      </div>
      <CannedResponsesContent />
    </div>
  );
};

export default CannedResponses;

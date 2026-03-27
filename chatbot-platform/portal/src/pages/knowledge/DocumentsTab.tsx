import React, { useState, useEffect, useMemo } from 'react';
import { Plus, Search, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { InlineError } from '@/components/ui/inline-error';
import { useAppAuth } from '@/auth/useAppAuth';
import { useKnowledgeDocuments, useDeleteDocument, useRetryDocument } from '@/queries/useKnowledgeQueries';
import DocumentCard from './DocumentCard';
import AddDocumentModal from './AddDocumentModal';

const typeFilters = ['all', 'pdf', 'docx', 'text', 'faq'] as const;
const statusFilters = ['failed', 'processing', 'pending', 'indexed'];

interface DocumentsTabProps {
  initialFilter?: string;
}

const DocumentsTab: React.FC<DocumentsTabProps> = ({ initialFilter }) => {
  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: documents = [], isLoading, error } = useKnowledgeDocuments() as { data: any[]; isLoading: boolean; error: any };
  const deleteDoc = useDeleteDocument();
  const retryDoc = useRetryDocument();

  const [typeFilter, setTypeFilter] = useState<string>(initialFilter || 'all');
  const [search, setSearch] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [editingDoc, setEditingDoc] = useState<any>(null);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);

  // Sync filter from parent (e.g., clicking failed count in Overview)
  useEffect(() => {
    if (initialFilter) setTypeFilter(initialFilter);
  }, [initialFilter]);

  const filtered = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result = documents as any[];
    if (typeFilter !== 'all') {
      const isStatus = statusFilters.includes(typeFilter);
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

  if (isLoading) return <PageSkeleton variant="cards" />;
  if (error) return <InlineError message="Failed to load documents" />;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        <div className="flex gap-1.5 flex-wrap">
          {typeFilters.map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all duration-150 ${
                typeFilter === f
                  ? 'bg-primary-500 text-white shadow-sm'
                  : 'bg-surface-2 text-text-muted hover:text-text-secondary hover:bg-surface-3'
              }`}
            >
              {f === 'all' ? 'All' : f.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
            <Input
              placeholder="Search documents..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-52 pl-8 h-8 text-xs"
            />
          </div>
          {isAdmin && (
            <Button size="sm" onClick={() => setIsModalOpen(true)}>
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              Add Document
            </Button>
          )}
        </div>
      </div>

      {/* Card Grid */}
      {filtered.length === 0 && !isLoading ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          {documents.length === 0 ? (
            <>
              <div className="p-4 rounded-2xl bg-primary-500/5 mb-4">
                <Upload className="w-8 h-8 text-primary-400/60" />
              </div>
              <h3 className="text-base font-medium text-text-primary">No documents yet</h3>
              <p className="text-xs text-text-muted mt-1.5 max-w-xs leading-relaxed">
                {isAdmin
                  ? 'Upload PDFs, paste text, or add FAQs to train your AI bot.'
                  : 'No documents have been added to the knowledge base yet.'}
              </p>
              {isAdmin && (
                <Button size="sm" className="mt-5" onClick={() => setIsModalOpen(true)}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                  Add your first document
                </Button>
              )}
            </>
          ) : (
            <>
              <div className="p-4 rounded-2xl bg-surface-2 mb-4">
                <Search className="w-8 h-8 text-text-muted/40" />
              </div>
              <h3 className="text-base font-medium text-text-primary">No matching documents</h3>
              <p className="text-xs text-text-muted mt-1.5">
                Try adjusting your search or filter.
              </p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => { setTypeFilter('all'); setSearch(''); }}>
                Clear filters
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((doc) => (
            <DocumentCard
              key={doc.id}
              document={doc}
              onEdit={() => handleEdit(doc)}
              onRetry={() => retryDoc.mutate(doc.id)}
              onDelete={() => setDeletingDocId(doc.id)}
            />
          ))}
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

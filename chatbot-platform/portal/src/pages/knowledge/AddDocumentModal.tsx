import React, { useState, useEffect, useRef } from 'react';
import { Modal } from '@/components/Modal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Loader2, Upload, FileText, HelpCircle, FileType, X, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
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

const docTypes: { value: DocType; label: string; description: string; icon: React.ElementType; accent: string }[] = [
  { value: 'text', label: 'Text', description: 'Paste articles, guides, or policies', icon: FileText, accent: 'border-violet-500/40 bg-violet-500/5 text-violet-400' },
  { value: 'faq', label: 'FAQ', description: 'Question & answer pairs', icon: HelpCircle, accent: 'border-amber-500/40 bg-amber-500/5 text-amber-400' },
  { value: 'pdf', label: 'PDF', description: 'Upload a PDF document', icon: FileType, accent: 'border-rose-500/40 bg-rose-500/5 text-rose-400' },
  { value: 'docx', label: 'DOCX', description: 'Upload a Word document', icon: FileType, accent: 'border-blue-500/40 bg-blue-500/5 text-blue-400' },
];

const AddDocumentModal: React.FC<AddDocumentModalProps> = ({ isOpen, onClose, editingDocument }) => {
  const isEditing = !!editingDocument;
  const [docType, setDocType] = useState<DocType>('text');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const createDoc = useCreateDocument();
  const updateDoc = useUpdateDocument();
  const uploadFile = useUploadFile();

  const isSubmitting = createDoc.isPending || updateDoc.isPending || uploadFile.isPending;
  const isFileType = docType === 'pdf' || docType === 'docx';
  const selectedType = docTypes.find((t) => t.value === docType)!;

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

  const MAX_FILE_SIZE = 25 * 1024 * 1024;
  const MAX_CONTENT_LENGTH = 500_000;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isFileType && file && file.size > MAX_FILE_SIZE) {
      toast.error('File exceeds 25MB limit');
      return;
    }
    if (!isFileType && content.length > MAX_CONTENT_LENGTH) {
      toast.error('Content exceeds 500,000 character limit');
      return;
    }

    if (isEditing) {
      updateDoc.mutate(
        { id: editingDocument!.id, data: { title, sourceContent: isFileType ? undefined : content } },
        { onSuccess: onClose },
      );
      return;
    }

    if (isFileType && file) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await uploadFile.mutateAsync(file);
        const token = (result as any)?.uploadToken;
        createDoc.mutate(
          { type: docType, title, uploadToken: token },
          { onSuccess: onClose },
        );
      } catch {
        // uploadFile.onError already shows toast
      }
    } else {
      createDoc.mutate(
        { type: docType, title, sourceContent: content },
        { onSuccess: onClose },
      );
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) {
      setFile(dropped);
      if (!title) setTitle(dropped.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] || null;
    setFile(selected);
    if (selected && !title) setTitle(selected.name.replace(/\.[^.]+$/, ''));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isEditing ? 'Edit Document' : 'Add Document'} size="md">
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Document Type Selector */}
        {!isEditing && (
          <div>
            <Label className="mb-2.5 text-text-secondary text-xs">Document Type</Label>
            <div className="grid grid-cols-4 gap-2">
              {docTypes.map((type) => {
                const Icon = type.icon;
                const isSelected = docType === type.value;
                return (
                  <button
                    key={type.value}
                    type="button"
                    onClick={() => { setDocType(type.value); setFile(null); }}
                    className={cn(
                      'flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all text-center',
                      isSelected
                        ? type.accent
                        : 'border-transparent bg-surface-2 text-text-muted hover:bg-surface-3'
                    )}
                  >
                    <Icon className="w-5 h-5" />
                    <span className="text-xs font-medium">{type.label}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-text-muted mt-1.5">{selectedType.description}</p>
          </div>
        )}

        {/* Title */}
        <div>
          <Label className="mb-1.5 text-text-secondary text-xs">Title</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              docType === 'faq' ? 'e.g. Shipping & Returns FAQ'
              : docType === 'pdf' ? 'e.g. Product Manual 2026'
              : 'e.g. Company Refund Policy'
            }
            required
          />
        </div>

        {/* Content Area */}
        {isFileType && isEditing ? (
          <div className="p-4 rounded-xl bg-surface-2 border border-edge">
            <p className="text-xs text-text-muted">File re-upload is not supported. Delete and re-create to change the file.</p>
          </div>
        ) : isFileType ? (
          <div>
            <Label className="mb-1.5 text-text-secondary text-xs">File</Label>
            <div
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={() => setIsDragOver(false)}
              onClick={() => !file && fileInputRef.current?.click()}
              className={cn(
                'relative border-2 border-dashed rounded-xl transition-all',
                file
                  ? 'border-emerald-500/30 bg-emerald-500/5 p-4'
                  : isDragOver
                    ? 'border-primary-500 bg-primary-500/5 p-8 cursor-pointer'
                    : 'border-edge p-8 cursor-pointer hover:border-primary-500/40 hover:bg-surface-2'
              )}
            >
              {file ? (
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10">
                    <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{file.name}</p>
                    <p className="text-xs text-text-muted">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setFile(null); }}
                    className="p-1 rounded-md hover:bg-surface-3 text-text-muted"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <div className="text-center">
                  <div className="inline-flex p-3 rounded-xl bg-surface-2 mb-3">
                    <Upload className="w-6 h-6 text-text-muted" />
                  </div>
                  <p className="text-sm text-text-secondary">
                    Drop your {docType.toUpperCase()} here or <span className="text-primary-400 font-medium">browse</span>
                  </p>
                  <p className="text-[10px] text-text-muted mt-1">Up to 25 MB</p>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept={docType === 'pdf' ? '.pdf' : '.docx'}
                onChange={handleFileSelect}
                className="hidden"
              />
            </div>
          </div>
        ) : (
          <div>
            <Label className="mb-1.5 text-text-secondary text-xs">Content</Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={
                docType === 'faq'
                  ? 'Q: How long does shipping take?\nA: Standard shipping takes 5-7 business days.\n\nQ: What is your return policy?\nA: You can return items within 30 days of purchase.'
                  : 'Paste your document content here...'
              }
              rows={10}
              required
              className="font-mono text-xs leading-relaxed"
            />
            {content.length > 0 && (
              <p className={cn(
                'text-[10px] mt-1 text-right',
                content.length > MAX_CONTENT_LENGTH * 0.9 ? 'text-amber-400' : 'text-text-muted'
              )}>
                {content.length.toLocaleString()} / {MAX_CONTENT_LENGTH.toLocaleString()}
              </p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={isSubmitting || (!title.trim()) || (!isFileType && !content.trim()) || (isFileType && !file && !isEditing)}
          >
            {isSubmitting && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
            {isEditing ? 'Save Changes' : 'Add Document'}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default AddDocumentModal;

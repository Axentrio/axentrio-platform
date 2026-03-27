import React, { useState, useEffect, useRef } from 'react';
import { Modal } from '@/components/Modal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
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

  const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
  const MAX_CONTENT_LENGTH = 500_000;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Client-side validation
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

        {isFileType && isEditing ? (
          <div>
            <Label className="mb-1 text-text-secondary">File</Label>
            <p className="text-sm text-text-muted">File re-upload is not supported yet. Delete and re-create the document to change the file.</p>
          </div>
        ) : isFileType ? (
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

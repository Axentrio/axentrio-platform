import React from 'react';
import { Card } from '@/components/ui/card';
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
  indexed: { color: 'text-emerald-400', label: 'Indexed' },
  processing: { color: 'text-amber-400', label: 'Processing' },
  pending: { color: 'text-text-muted', label: 'Pending' },
  failed: { color: 'text-red-400', label: 'Failed' },
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
                <DropdownMenuItem onClick={onDelete} className="text-red-400">
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
        <div className="mt-3 p-2 bg-red-400/10 rounded-lg">
          <p className="text-xs text-red-400 line-clamp-1">{document.errorMessage}</p>
          {isAdmin && (
            <button
              onClick={onRetry}
              className="text-xs text-red-400 underline mt-1"
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

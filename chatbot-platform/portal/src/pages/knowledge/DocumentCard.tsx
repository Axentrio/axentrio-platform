import React from 'react';
import { Card } from '@/components/ui/card';
import { FileText, FileEdit, HelpCircle, MoreVertical, RotateCcw } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { useAppAuth } from '@/auth/useAppAuth';
import { timeAgo } from '@/utils/timeAgo';

interface DocumentCardProps {
  document: {
    id: string;
    type: 'text' | 'faq' | 'pdf' | 'docx';
    title: string;
    status: 'pending' | 'processing' | 'indexed' | 'failed';
    chunkCount: number;
    errorMessage?: string | null;
    updatedAt: string;
    qualityReport?: {
      contentType: string;
      contentSummary: string;
      qualityScore: 'excellent' | 'good' | 'fair' | 'poor';
      qualityReason: string;
      transformedSections: number;
      strippedSections: number;
      chunksCreated: number;
    } | null;
  };
  onEdit: () => void;
  onRetry: () => void;
  onDelete: () => void;
}

const qualityConfig: Record<string, { color: string; label: string }> = {
  excellent: { color: 'bg-emerald-400', label: 'Excellent quality' },
  good: { color: 'bg-emerald-400', label: 'Good quality' },
  fair: { color: 'bg-amber-400', label: 'Fair quality' },
  poor: { color: 'bg-red-400', label: 'Poor quality' },
};

const typeConfig: Record<string, { icon: React.ElementType; label: string; accent: string }> = {
  pdf: { icon: FileText, label: 'PDF', accent: 'text-rose-400 bg-rose-400/10' },
  docx: { icon: FileText, label: 'DOCX', accent: 'text-blue-400 bg-blue-400/10' },
  text: { icon: FileEdit, label: 'TEXT', accent: 'text-violet-400 bg-violet-400/10' },
  faq: { icon: HelpCircle, label: 'FAQ', accent: 'text-amber-400 bg-amber-400/10' },
};

const statusConfig: Record<string, { dot: string; label: string; bg: string }> = {
  indexed: { dot: 'bg-emerald-400', label: 'Indexed', bg: 'bg-emerald-400/10 text-emerald-400' },
  processing: { dot: 'bg-amber-400 animate-pulse', label: 'Processing', bg: 'bg-amber-400/10 text-amber-400' },
  pending: { dot: 'bg-text-muted', label: 'Pending', bg: 'bg-surface-3 text-text-muted' },
  failed: { dot: 'bg-red-400', label: 'Failed', bg: 'bg-red-400/10 text-red-400' },
};

const DocumentCard: React.FC<DocumentCardProps> = ({ document, onEdit, onRetry, onDelete }) => {
  const { isRole } = useAppAuth();
  const isAdmin = isRole('admin');
  const type = typeConfig[document.type] || typeConfig.text;
  const status = statusConfig[document.status] || statusConfig.pending;
  const Icon = type.icon;

  return (
    <Card className="group relative p-4 hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-200 cursor-default">
      {/* Top: Icon + Status + Actions */}
      <div className="flex justify-between items-start mb-3">
        <div className={`p-2 rounded-lg ${type.accent}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${status.bg}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            {status.label}
          </span>
          {isAdmin && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity">
                  <MoreVertical className="w-3.5 h-3.5" />
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

      {/* Title */}
      <h3 className="text-sm font-medium text-text-primary line-clamp-1 mb-1">
        {document.title}
      </h3>

      {/* Meta */}
      <div className="flex items-center gap-2 text-[11px] text-text-muted">
        <span>{type.label}</span>
        <span className="w-0.5 h-0.5 rounded-full bg-text-muted" />
        <span>{document.chunkCount} {document.chunkCount === 1 ? 'chunk' : 'chunks'}</span>
        <span className="w-0.5 h-0.5 rounded-full bg-text-muted" />
        <span>{timeAgo(document.updatedAt)}</span>
      </div>

      {/* Quality indicator */}
      {document.qualityReport && document.status === 'indexed' && (
        <div className="mt-2 flex items-center gap-1.5" title={document.qualityReport.qualityReason}>
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${qualityConfig[document.qualityReport.qualityScore]?.color || 'bg-gray-400'}`} />
          <span className="text-[10px] text-text-muted truncate">
            {document.qualityReport.contentSummary
              ? document.qualityReport.contentSummary.slice(0, 60) + (document.qualityReport.contentSummary.length > 60 ? '...' : '')
              : qualityConfig[document.qualityReport.qualityScore]?.label}
          </span>
        </div>
      )}

      {/* Quality warning for fair/poor */}
      {document.qualityReport && ['poor', 'fair'].includes(document.qualityReport.qualityScore) && document.status === 'indexed' && (
        <p className="text-[10px] text-amber-400/80 mt-1">
          {document.qualityReport.qualityReason}
        </p>
      )}

      {/* Processing progress bar */}
      {document.status === 'processing' && (
        <div className="mt-3 h-1 rounded-full bg-surface-3 overflow-hidden">
          <div className="h-full w-1/2 rounded-full bg-amber-400 animate-pulse" />
        </div>
      )}

      {/* Error state */}
      {document.status === 'failed' && document.errorMessage && (
        <div className="mt-3 flex items-start gap-2 p-2 bg-red-400/5 rounded-lg border border-red-400/10">
          <p className="text-[11px] text-red-400/80 line-clamp-2 flex-1">{document.errorMessage}</p>
          {isAdmin && (
            <button
              onClick={onRetry}
              className="flex-shrink-0 p-1 rounded hover:bg-red-400/10 transition-colors"
              title="Retry processing"
            >
              <RotateCcw className="w-3 h-3 text-red-400" />
            </button>
          )}
        </div>
      )}
    </Card>
  );
};

export default DocumentCard;

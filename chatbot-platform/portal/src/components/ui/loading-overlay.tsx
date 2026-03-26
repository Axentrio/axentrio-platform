import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LoadingOverlayProps {
  isLoading: boolean;
  message?: string;
  className?: string;
}

export function LoadingOverlay({ isLoading, message, className }: LoadingOverlayProps) {
  if (!isLoading) return null;

  return (
    <div
      className={cn(
        'absolute inset-0 z-50 flex flex-col items-center justify-center',
        'bg-surface-0/70 backdrop-blur-[2px] rounded-lg',
        className,
      )}
    >
      <Loader2 className="w-6 h-6 animate-spin text-primary-400" />
      {message && (
        <p className="mt-2 text-sm text-text-secondary">{message}</p>
      )}
    </div>
  );
}

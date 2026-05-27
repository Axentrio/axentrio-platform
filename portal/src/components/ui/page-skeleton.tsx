import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface PageSkeletonProps {
  variant: 'table' | 'cards' | 'list';
  rows?: number;
  className?: string;
}

export function PageSkeleton({ variant, rows = 5, className }: PageSkeletonProps) {
  return (
    <div className={cn('p-6 space-y-6', className)}>
      {variant === 'table' && <TableSkeleton rows={rows} />}
      {variant === 'cards' && <CardsSkeleton rows={rows} />}
      {variant === 'list' && <ListSkeleton rows={rows} />}
    </div>
  );
}

function TableSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {/* Filter/search bar */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-64 rounded-lg" />
        <Skeleton className="h-9 w-32 rounded-lg" />
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>
      {/* Table header */}
      <div className="flex items-center gap-4 px-4 py-3">
        <Skeleton className="h-4 w-1/4" />
        <Skeleton className="h-4 w-1/6" />
        <Skeleton className="h-4 w-1/6" />
        <Skeleton className="h-4 w-1/5" />
        <Skeleton className="h-4 w-20" />
      </div>
      {/* Table rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-4 border-t border-edge">
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-4 w-1/6" />
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-4 w-1/5" />
          <Skeleton className="h-8 w-20 rounded-lg" />
        </div>
      ))}
    </>
  );
}

function CardsSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: Math.min(rows, 4) }).map((_, i) => (
          <div key={i} className="p-6 rounded-xl border border-edge bg-surface-1">
            <div className="flex items-start justify-between">
              <div className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-16" />
              </div>
              <Skeleton className="w-12 h-12 rounded-xl" />
            </div>
          </div>
        ))}
      </div>
      {/* Chart placeholder */}
      <Skeleton className="h-64 w-full rounded-xl" />
    </>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <>
      {/* Header area */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>
      {/* List items */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 p-4 rounded-xl border border-edge">
          <Skeleton className="w-10 h-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      ))}
    </>
  );
}

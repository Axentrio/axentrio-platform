import { cn } from "@/lib/utils"

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  isLoading?: boolean;
}

export function Pagination({ page, totalPages, onPageChange, isLoading }: PaginationProps) {
  if (totalPages <= 1) return null;

  const buttonClass = cn(
    "px-3 py-1.5 text-sm font-medium rounded-lg border border-edge bg-surface-1 text-text-primary",
    "transition-colors duration-150",
    "hover:bg-surface-2 hover:border-edge-light",
    "disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-surface-1 disabled:hover:border-edge",
  );

  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div className="text-sm text-text-secondary">
        Page {page} of {totalPages}
      </div>
      <div className="flex gap-2">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1 || isLoading}
          className={buttonClass}
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages || isLoading}
          className={buttonClass}
        >
          Next
        </button>
      </div>
    </div>
  );
}

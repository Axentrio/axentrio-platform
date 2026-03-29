import React, { useState, useEffect } from 'react';
import { Zap, Search } from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import { useCannedResponses, useUseCannedResponse } from '../queries/useCannedResponseQueries';
import type { CannedResponse } from '../queries/useCannedResponseQueries';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface SlashCommandDropdownProps {
  query: string;
  onSelect: (content: string) => void;
  onClose: () => void;
  visible: boolean;
}

export const SlashCommandDropdown: React.FC<SlashCommandDropdownProps> = ({
  query,
  onSelect,
  onClose: _onClose,
  visible,
}) => {
  const { user } = useAppAuth();
  const { data } = useCannedResponses();
  const useMutation = useUseCannedResponse();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const responses: CannedResponse[] = data?.data ?? [];
  const filtered = responses.filter((r) =>
    r.shortcut.toLowerCase().startsWith(query.toLowerCase())
  );

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = async (cr: CannedResponse) => {
    try {
      const result = await useMutation.mutateAsync({
        id: cr.id,
        variables: { agent_name: user?.firstName ?? '' },
      });
      onSelect((result as any)?.content ?? cr.content);
    } catch {
      onSelect(cr.content);
    }
  };

  // Keyboard handler — called from ChatWindow's onKeyDown to avoid conflicts
  // This is exposed via the `onKeyDown` prop pattern below

  if (!visible || filtered.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Canned responses"
      className="absolute bottom-full left-0 right-0 mb-1 bg-surface-2 border border-edge rounded-lg shadow-lg max-h-[200px] overflow-y-auto z-50"
    >
      {filtered.map((cr, i) => (
        <button
          key={cr.id}
          role="option"
          aria-selected={i === selectedIndex}
          className={cn(
            'w-full px-3 min-h-[44px] text-left text-sm flex items-center justify-between hover:bg-surface-3',
            i === selectedIndex && 'bg-surface-3'
          )}
          onMouseDown={(e) => {
            e.preventDefault();
            handleSelect(cr);
          }}
        >
          <div className="min-w-0 mr-2">
            <div className="flex items-center gap-2">
              <span className="font-medium text-text-primary">{cr.title}</span>
              <span className="text-text-muted">/{cr.shortcut}</span>
            </div>
            <div className="text-xs text-text-muted truncate">{cr.content}</div>
          </div>
          {cr.category && (
            <span className="text-xs text-text-muted flex-shrink-0">{cr.category}</span>
          )}
        </button>
      ))}
    </div>
  );
};

// Export keyboard handler for use in ChatWindow
export function useSlashCommandKeyboard(
  visible: boolean,
  filteredCount: number,
  _selectedIndex: number,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>,
) {
  return (e: React.KeyboardEvent): boolean => {
    if (!visible || filteredCount === 0) return false;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filteredCount - 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
      return true;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      return true; // Signal to ChatWindow to trigger selection
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      return true;
    }
    return false;
  };
}

interface CannedResponsePickerButtonProps {
  onSelect: (content: string) => void;
}

export const CannedResponsePickerButton: React.FC<CannedResponsePickerButtonProps> = ({
  onSelect,
}) => {
  const { user } = useAppAuth();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { data } = useCannedResponses();
  const useMutation = useUseCannedResponse();

  const responses: CannedResponse[] = data?.data ?? [];
  const filtered = search
    ? responses.filter(
        (r) =>
          r.title.toLowerCase().includes(search.toLowerCase()) ||
          r.shortcut.toLowerCase().includes(search.toLowerCase())
      )
    : responses;

  // Group by category
  const grouped = filtered.reduce<Record<string, CannedResponse[]>>((acc, r) => {
    const cat = r.category ?? 'Uncategorized';
    (acc[cat] ??= []).push(r);
    return acc;
  }, {});

  const handleSelect = async (cr: CannedResponse) => {
    try {
      const result = await useMutation.mutateAsync({
        id: cr.id,
        variables: { agent_name: user?.firstName ?? '' },
      });
      onSelect((result as any)?.content ?? cr.content);
    } catch {
      onSelect(cr.content);
    }
    setOpen(false);
    setSearch('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl flex-shrink-0"
          title="Canned responses"
        >
          <Zap className="w-5 h-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start" side="top">
        <div className="p-2 border-b border-edge">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <Input
              placeholder="Search responses..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-sm"
              autoFocus
            />
          </div>
        </div>
        <div className="px-3 py-1.5 text-xs text-text-muted border-b border-edge">
          Tip: Type <kbd className="px-1 py-0.5 bg-surface-3 rounded text-[10px] font-mono">/</kbd> in chat to quick-select
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {Object.keys(grouped).length === 0 ? (
            <div className="p-4 text-center text-sm text-text-muted">
              No responses found
            </div>
          ) : (
            Object.entries(grouped).map(([category, items]) => (
              <div key={category}>
                <div className="px-3 py-1.5 text-xs font-medium text-text-muted uppercase tracking-wider bg-surface-1">
                  {category}
                </div>
                {items.map((cr) => (
                  <button
                    key={cr.id}
                    className="w-full px-3 min-h-[44px] py-2 text-left text-sm hover:bg-surface-3 flex items-center justify-between"
                    onClick={() => handleSelect(cr)}
                  >
                    <div className="min-w-0 mr-2">
                      <div className="font-medium text-text-primary truncate">{cr.title}</div>
                      <div className="text-xs text-text-muted truncate">
                        {cr.content}
                      </div>
                    </div>
                    <code className="text-xs text-text-muted flex-shrink-0">/{cr.shortcut}</code>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};

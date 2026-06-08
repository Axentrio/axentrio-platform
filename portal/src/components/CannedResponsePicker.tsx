import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  registerKeyHandler?: (handler: (e: React.KeyboardEvent) => boolean) => void;
}

// Resolve {{variables}} client-side for instant insertion
function resolveVariables(content: string, variables: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key) => variables[key] ?? match);
}

export const SlashCommandDropdown: React.FC<SlashCommandDropdownProps> = ({
  query,
  onSelect,
  onClose,
  visible,
  registerKeyHandler,
}) => {
  const { user } = useAppAuth();
  const { data } = useCannedResponses();
  const useMutation = useUseCannedResponse();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedIndexRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const responses: CannedResponse[] = data?.data ?? [];
  const filtered = responses.filter((r) =>
    r.shortcut.toLowerCase().startsWith(query.toLowerCase())
  );
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;

  // Reset the highlighted option whenever the query changes — done during
  // render (React's adjusting-state pattern) so the selection never lags a
  // frame behind the filtered list.
  const [prevQuery, setPrevQuery] = useState(query);
  if (query !== prevQuery) {
    setPrevQuery(query);
    setSelectedIndex(0);
    selectedIndexRef.current = 0;
  }

  // Keep ref in sync with state
  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[role="option"]');
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelect = useCallback((cr: CannedResponse) => {
    const resolved = resolveVariables(cr.content, {
      agent_name: user?.firstName ?? '',
    });
    onSelect(resolved);
    useMutation.mutate({ id: cr.id, variables: { agent_name: user?.firstName ?? '' } });
  }, [user?.firstName, onSelect, useMutation]);

  // Register keyboard handler — uses refs to always have fresh values
  useEffect(() => {
    if (!registerKeyHandler) return;

    const handler = (e: React.KeyboardEvent): boolean => {
      const f = filteredRef.current;
      if (!visible || f.length === 0) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => {
          const next = Math.min(i + 1, f.length - 1);
          selectedIndexRef.current = next;
          return next;
        });
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => {
          const next = Math.max(i - 1, 0);
          selectedIndexRef.current = next;
          return next;
        });
        return true;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const idx = selectedIndexRef.current;
        if (f[idx]) {
          handleSelect(f[idx]);
        }
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return true;
      }
      return false;
    };

    registerKeyHandler(handler);
  });

  if (!visible || filtered.length === 0) return null;

  return (
    <div
      ref={listRef}
      // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- custom combobox listbox, native datalist not suitable here
      role="listbox"
      aria-label="Canned responses"
      className="absolute bottom-full left-0 right-0 mb-1 bg-surface-2 border border-edge rounded-lg shadow-lg max-h-[200px] overflow-y-auto z-50"
    >
      {filtered.map((cr, i) => (
        <button
          type="button"
          key={cr.id}
          role="option"
          aria-selected={i === selectedIndex}
          className={cn(
            'w-full px-3 min-h-[44px] text-left text-sm flex items-center justify-between hover:bg-surface-3 transition-colors',
            i === selectedIndex && 'bg-primary-500/10 border-l-2 border-primary-500'
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

  const handleSelect = (cr: CannedResponse) => {
    // Insert immediately with client-side variable resolution
    const resolved = resolveVariables(cr.content, {
      agent_name: user?.firstName ?? '',
    });
    onSelect(resolved);
    setOpen(false);
    setSearch('');

    // Track usage in background (fire-and-forget)
    useMutation.mutate({ id: cr.id, variables: { agent_name: user?.firstName ?? '' } });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl flex-shrink-0"
          title="Canned responses"
          aria-label="Canned responses"
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
                    type="button"
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

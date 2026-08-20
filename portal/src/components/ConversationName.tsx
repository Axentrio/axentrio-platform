import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { ChannelBadge } from './ChannelBadge';
import { useRenameConversation } from '../queries/useChatQueries';
import type { Chat } from '@app-types/index';

export function ConversationName({
  chat,
  heading,
  onRenamed,
}: {
  chat: Chat;
  heading?: 'h2' | 'h3' | 'span';
  onRenamed?: (userName: string) => void;
}) {
  const { t } = useTranslation();
  const rename = useRenameConversation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chat.userName ?? '');

  useEffect(() => {
    if (!editing) setDraft(chat.userName ?? '');
  }, [chat.userName, editing]);

  const Tag = heading ?? 'span';
  const display = chat.userName || t('inbox.chat.anonymousUser');

  const commit = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === chat.userName) return;
    onRenamed?.(next);
    try {
      await rename(chat.id, next);
    } catch {
      onRenamed?.(chat.userName || '');
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, 100))}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
            if (e.key === 'Escape') setEditing(false);
          }}
          maxLength={100}
          autoFocus
          aria-label={t('inbox.chat.rename')}
          className="h-8 max-w-[220px] text-sm"
        />
        <ChannelBadge channel={chat.channel} source={chat.metadata?.source} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 min-w-0">
      <Tag className="font-semibold text-text-primary truncate">{display}</Tag>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="shrink-0 p-0.5 rounded text-text-muted hover:text-text-primary"
        aria-label={t('inbox.chat.rename')}
        title={t('inbox.chat.rename')}
      >
        <Pencil className="w-3.5 h-3.5" />
      </button>
      <ChannelBadge channel={chat.channel} source={chat.metadata?.source} />
    </div>
  );
}

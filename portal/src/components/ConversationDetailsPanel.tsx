/**
 * Right-rail case file for the open Inbox conversation.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Download,
  Mail,
  MapPin,
  Phone,
  Plus,
  Tag,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChannelBadge } from './ChannelBadge';
import { ChatStatusBadge } from './StatusBadge';
import { cn } from '@/lib/utils';
import { chatOptions, useUpdateConversationTags } from '../queries/useChatQueries';
import type { Chat, Message } from '@app-types/index';

export function buildTranscriptText(chat: Chat, messages: Message[]): string {
  const header = [chat.userName, chat.channel, chat.id].filter(Boolean).join(' · ');
  const lines = messages.map((m) => {
    const who = m.senderName || m.sender;
    return `[${m.createdAt}] ${who}: ${m.content}`;
  });
  return [header, '', ...lines].join('\n');
}

export function downloadTranscript(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatActivityAt(
  iso: string,
  locale: string,
  today: (time: string) => string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  if (date.toDateString() === new Date().toDateString()) return today(time);
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 border-b border-edge last:border-0">
      <span className="text-xs text-text-muted shrink-0">{label}</span>
      <span className="text-sm font-medium text-text-primary text-right min-w-0 tabular-nums">
        {children}
      </span>
    </div>
  );
}

const tabTriggerClass =
  'rounded-none border-b-2 border-transparent bg-transparent px-3 py-2 shadow-none data-[state=active]:border-primary-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none';

export function ConversationDetailsPanel({
  chat,
  workspaceName,
  onAssign,
  className,
}: {
  chat: Chat;
  workspaceName?: string | null;
  onAssign?: () => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  const { data: detail } = useQuery({ ...chatOptions.detail(chat.id) });
  const row: Chat = detail ? { ...chat, ...detail } : chat;
  const messages: Message[] = detail?.messages ?? chat.messages ?? [];
  const locale = i18n.resolvedLanguage || i18n.language || 'en';
  const today = (time: string) => t('inbox.details.today', { time });
  const firstAt = row.createdAt;
  const lastAt = row.lastActivityAt || row.lastMessageAt || row.updatedAt;
  const activity = useMemo(() => {
    const events: Array<{ key: string; at: string }> = [];
    if (firstAt) events.push({ key: 'started', at: firstAt });
    if (lastAt && lastAt !== firstAt) events.push({ key: 'last', at: lastAt });
    if (row.closedAt) events.push({ key: 'closed', at: row.closedAt });
    return events;
  }, [firstAt, lastAt, row.closedAt]);

  return (
    <aside
      className={cn(
        'w-[300px] min-w-[280px] max-w-[340px] flex-shrink-0 border-l border-edge bg-surface-1 overflow-y-auto',
        className,
      )}
      data-testid="conversation-details-panel"
    >
      <Tabs defaultValue="details" className="px-4 py-3">
        <TabsList className="h-auto w-full justify-start gap-0 rounded-none bg-transparent p-0 border-b border-edge">
          <TabsTrigger value="details" className={tabTriggerClass}>
            {t('inbox.details.tab')}
          </TabsTrigger>
          <TabsTrigger value="activity" className={tabTriggerClass}>
            {t('inbox.details.activityTab')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="details" className="mt-4 space-y-6">
          <DetailsTab
            row={row}
            messages={messages}
            workspaceName={workspaceName}
            locale={locale}
            today={today}
            onAssign={onAssign}
          />
        </TabsContent>
        <TabsContent value="activity" className="mt-4">
          <ActivityTab events={activity} locale={locale} today={today} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function DetailsTab({
  row,
  messages,
  workspaceName,
  locale,
  today,
  onAssign,
}: {
  row: Chat;
  messages: Message[];
  workspaceName?: string | null;
  locale: string;
  today: (time: string) => string;
  onAssign?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const updateTags = useUpdateConversationTags();
  const [labelOpen, setLabelOpen] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const tags = row.tags ?? [];
  const canAssign = row.ownership === 'human_owned' && !!onAssign && row.status !== 'closed';
  const hasContact = !!(row.userPhone || row.userEmail || row.location);

  const saveTags = async (next: string[]) => {
    try {
      await updateTags(row.id, next);
      toast.success(t('inbox.toasts.tagsUpdated'));
    } catch {
      toast.error(t('inbox.toasts.tagsFailed'));
    }
  };

  const addLabel = async () => {
    const tag = draftLabel.trim();
    setDraftLabel('');
    setLabelOpen(false);
    if (!tag) return;
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) return;
    await saveTags([...tags, tag]);
  };

  return (
    <>
      {hasContact && <ContactSection row={row} onViewProfile={() => navigate('/leads')} />}
      <OverviewSection row={row} workspaceName={workspaceName} locale={locale} today={today} />
      <LabelsSection
        tags={tags}
        labelOpen={labelOpen}
        draftLabel={draftLabel}
        onOpenChange={setLabelOpen}
        onDraftChange={setDraftLabel}
        onAdd={() => void addLabel()}
        onRemove={(tag) => void saveTags(tags.filter((item) => item !== tag))}
      />
      <ActionsSection
        hasLead={!!row.leadId}
        canAssign={canAssign}
        onViewLead={() => navigate('/leads')}
        onAddLabel={() => setLabelOpen(true)}
        onAssign={onAssign}
        onExport={() => {
          downloadTranscript(
            `conversation-${row.id.slice(0, 8)}.txt`,
            buildTranscriptText(row, messages),
          );
          toast.success(t('inbox.toasts.exported'));
        }}
      />
    </>
  );
}

function ContactLine({ icon: Icon, children }: { icon: typeof Phone; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0 text-sm text-text-primary">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-text-muted">
        <Icon className="w-3.5 h-3.5" />
      </span>
      <span className="truncate">{children}</span>
    </div>
  );
}

function ContactSection({ row, onViewProfile }: { row: Chat; onViewProfile: () => void }) {
  const { t } = useTranslation();
  return (
    <section>
      <h3 className="text-sm font-semibold text-text-primary mb-3">
        {t('inbox.details.contact.title')}
      </h3>
      <div className="space-y-2.5">
        {row.userPhone && <ContactLine icon={Phone}>{row.userPhone}</ContactLine>}
        {row.userEmail && <ContactLine icon={Mail}>{row.userEmail}</ContactLine>}
        {row.location && <ContactLine icon={MapPin}>{row.location}</ContactLine>}
      </div>
      {row.leadId && (
        <Button variant="outline" size="sm" className="mt-3 w-full rounded-lg" onClick={onViewProfile}>
          {t('inbox.details.contact.viewProfile')}
        </Button>
      )}
    </section>
  );
}

function OverviewSection({
  row,
  workspaceName,
  locale,
  today,
}: {
  row: Chat;
  workspaceName?: string | null;
  locale: string;
  today: (time: string) => string;
}) {
  const { t } = useTranslation();
  const firstAt = row.createdAt;
  const lastAt = row.lastActivityAt || row.lastMessageAt || row.updatedAt;
  const workspace = row.tenantName || workspaceName || null;
  return (
    <section>
      <h3 className="text-sm font-semibold text-text-primary mb-1">
        {t('inbox.details.overview.title')}
      </h3>
      {firstAt && (
        <FactRow label={t('inbox.details.overview.first')}>
          {formatActivityAt(firstAt, locale, today)}
        </FactRow>
      )}
      {lastAt && (
        <FactRow label={t('inbox.details.overview.last')}>
          {formatActivityAt(lastAt, locale, today)}
        </FactRow>
      )}
      {(row.channel || row.metadata?.source) && (
        <FactRow label={t('inbox.details.overview.channel')}>
          <ChannelBadge channel={row.channel} source={row.metadata?.source} />
        </FactRow>
      )}
      <FactRow label={t('inbox.details.overview.status')}>
        <ChatStatusBadge status={row.status} size="sm" />
      </FactRow>
      {workspace ? (
        <FactRow label={t('inbox.details.overview.workspace')}>{workspace}</FactRow>
      ) : null}
    </section>
  );
}

function LabelsSection({
  tags,
  labelOpen,
  draftLabel,
  onOpenChange,
  onDraftChange,
  onAdd,
  onRemove,
}: {
  tags: string[];
  labelOpen: boolean;
  draftLabel: string;
  onOpenChange: (open: boolean) => void;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
  onRemove: (tag: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-text-primary">
          {t('inbox.details.labels.title')}
        </h3>
        <LabelEditor
          open={labelOpen}
          onOpenChange={onOpenChange}
          draft={draftLabel}
          onDraftChange={onDraftChange}
          onSubmit={onAdd}
          addLabel={t('inbox.details.labels.add')}
          placeholder={t('inbox.details.labels.placeholder')}
        />
      </div>
      {tags.length === 0 ? (
        <p className="text-xs text-text-muted">{t('inbox.details.labels.empty')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1 font-medium">
              {tag}
              <button
                type="button"
                className="p-0.5 rounded hover:text-text-primary"
                aria-label={t('inbox.details.labels.remove', { tag })}
                onClick={() => onRemove(tag)}
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </section>
  );
}

function ActionsSection({
  hasLead,
  canAssign,
  onViewLead,
  onAddLabel,
  onAssign,
  onExport,
}: {
  hasLead: boolean;
  canAssign: boolean;
  onViewLead: () => void;
  onAddLabel: () => void;
  onAssign?: () => void;
  onExport: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section>
      <h3 className="text-sm font-semibold text-text-primary mb-2">
        {t('inbox.details.actions.title')}
      </h3>
      <div className="divide-y divide-edge rounded-lg border border-edge overflow-hidden">
        {hasLead && (
          <ActionRow icon={UserRound} label={t('inbox.details.actions.viewLead')} onClick={onViewLead} />
        )}
        <ActionRow icon={Tag} label={t('inbox.details.actions.addLabel')} onClick={onAddLabel} />
        {canAssign && (
          <ActionRow icon={Users} label={t('inbox.details.actions.assign')} onClick={onAssign} />
        )}
        <ActionRow icon={Download} label={t('inbox.details.actions.export')} onClick={onExport} />
      </div>
    </section>
  );
}

function ActivityTab({
  events,
  locale,
  today,
}: {
  events: Array<{ key: string; at: string }>;
  locale: string;
  today: (time: string) => string;
}) {
  const { t } = useTranslation();
  if (events.length === 0) {
    return <p className="text-sm text-text-muted">{t('inbox.details.activity.empty')}</p>;
  }
  return (
    <ol className="relative space-y-4 border-l border-edge ml-2 pl-4">
      {events.map((event) => (
        <li key={`${event.key}-${event.at}`} className="text-sm">
          <p className="text-text-primary">{t(`inbox.details.activity.${event.key}`)}</p>
          <p className="text-xs text-text-muted tabular-nums">
            {formatActivityAt(event.at, locale, today)}
          </p>
        </li>
      ))}
    </ol>
  );
}

function LabelEditor({
  open,
  onOpenChange,
  draft,
  onDraftChange,
  onSubmit,
  addLabel,
  placeholder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  addLabel: string;
  placeholder: string;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 rounded-lg text-text-muted"
          aria-label={addLabel}
        >
          <Plus className="w-4 h-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Input
            value={draft}
            onChange={(e) => onDraftChange(e.target.value.slice(0, 100))}
            placeholder={placeholder}
            maxLength={100}
            autoFocus
            aria-label={addLabel}
          />
        </form>
      </PopoverContent>
    </Popover>
  );
}

function ActionRow({
  icon: Icon,
  label,
  onClick,
}: {
  icon: typeof Download;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-text-primary hover:bg-surface-3"
      onClick={onClick}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-3 text-text-muted">
        <Icon className="w-3.5 h-3.5" />
      </span>
      {label}
    </button>
  );
}

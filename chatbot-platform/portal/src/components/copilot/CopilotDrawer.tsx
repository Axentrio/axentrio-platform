/**
 * The right-side slide-in panel for the Copilot.
 *
 * ~400px wide on desktop, full-screen on mobile. Persists across
 * route navigation (rendered once at App.tsx). Body-scroll lock +
 * Escape close are handled by the provider.
 *
 * Three states inside the drawer body:
 *   - LockedPreview (Essential tenant, or 402 mid-session)
 *   - Empty welcome (no active conversation)
 *   - Transcript + composer
 *
 * The transcript renders:
 *   - persisted user/assistant rows from useCopilotConversation()
 *   - the in-flight assistant turn (tokens streaming in real-time)
 *   - tool-call badges per assistant
 *   - outcome suffix (`[aborted]` / `[failed]` / `[interrupted]` /
 *     `[took too long]`) for non-success terminal states
 *
 * z-index reservation (documented at the file top for future modal
 * additions):
 *   drawer overlay  z-50
 *   drawer panel    z-50
 *   modal-over-drawer (e.g. upgrade confirmation) should use z-60
 *   toasts          z-70 (sonner default)
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Send, Trash2, X, Wrench } from 'lucide-react';
import { useHasFeature } from '../../queries/useEntitlementsQueries';
import { useCopilotConversation } from '../../queries/useCopilotQueries';
import type {
  CopilotAssistantMessage,
  CopilotConversationMessage,
  CopilotUserMessage,
} from '../../queries/useCopilotQueries';
import { Button } from '@components/ui/button';
import { Textarea } from '@components/ui/textarea';
import { cn } from '@/lib/utils';
import { useCopilotDrawer, type CopilotInflightTurn } from './CopilotDrawerProvider';
import { CopilotLockedPreview } from './CopilotLockedPreview';

const MOBILE_BREAKPOINT_QUERY = '(max-width: 640px)';

export function CopilotDrawer() {
  const { t } = useTranslation();
  const {
    isOpen,
    close,
    isStreaming,
    inflight,
    forcedToLockedPreview,
    rateLimitNotice,
    send,
    clear,
    isClearing,
  } = useCopilotDrawer();
  const hasFeature = useHasFeature('platformAssistant');
  // Only fetch the transcript when the drawer is actually open AND
  // the tenant has the entitlement. The unconditional fetch was
  // firing 402s on every layout mount for non-Pro tenants and
  // stacking plan-limit toasts (the global axios interceptor fires
  // a toast per 402). Pre-loading the transcript saves nothing —
  // the drawer is closed so nobody sees it.
  const transcript = useCopilotConversation({ enabled: isOpen && hasFeature });
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [composerValue, setComposerValue] = useState('');
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);

  // Body-scroll lock when open. Standard pattern; resilient to fast
  // open/close cycles.
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  // Autoscroll to the latest token as it streams in.
  useEffect(() => {
    if (!isOpen) return;
    scrollAnchorRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [isOpen, transcript.data?.messages.length, inflight?.assistant.content]);

  // Auto-focus the composer when the drawer opens (only if user is entitled).
  useEffect(() => {
    if (isOpen && hasFeature && !forcedToLockedPreview) {
      const handle = setTimeout(() => composerRef.current?.focus(), 50);
      return () => clearTimeout(handle);
    }
  }, [isOpen, hasFeature, forcedToLockedPreview]);

  const isMobile = useIsMobile();

  const handleSend = useCallback(
    (e?: FormEvent) => {
      e?.preventDefault();
      const text = composerValue.trim();
      if (!text || isStreaming) return;
      setComposerValue('');
      void send(text);
    },
    [composerValue, isStreaming, send],
  );

  const handleComposerKeydown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const showLocked = !hasFeature || forcedToLockedPreview;

  return (
    <>
      {/* Overlay */}
      <div
        aria-hidden={!isOpen}
        onClick={close}
        className={cn(
          'fixed inset-0 z-50 bg-surface-0/40 backdrop-blur-sm transition-opacity',
          isOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
      />
      {/* Panel */}
      <aside
        aria-hidden={!isOpen}
        aria-labelledby="copilot-drawer-title"
        role="dialog"
        className={cn(
          'fixed top-0 right-0 z-50 h-full bg-surface-0 border-l border-edge shadow-xl',
          'transition-transform duration-200 ease-out',
          isMobile ? 'w-full' : 'w-[400px]',
          isOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex h-full flex-col">
          <header className="flex items-center justify-between border-b border-edge px-4 py-3">
            <h2 id="copilot-drawer-title" className="text-base font-semibold text-text-primary">
              {t('copilot.drawer.title')}
            </h2>
            <div className="flex items-center gap-1">
              {hasFeature && !forcedToLockedPreview && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void clear()}
                  disabled={isClearing}
                  aria-label={t('copilot.drawer.clearAria')}
                  title={t('copilot.drawer.clear')}
                >
                  {isClearing ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={close}
                aria-label={t('copilot.drawer.closeAria')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </header>

          {showLocked ? (
            <CopilotLockedPreview />
          ) : (
            <>
              <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                {transcript.isLoading && (
                  <p className="text-sm text-text-tertiary">{t('copilot.drawer.loading')}</p>
                )}
                {!transcript.isLoading &&
                  (transcript.data?.messages.length ?? 0) === 0 &&
                  !inflight && (
                    <CopilotWelcome />
                  )}
                {transcript.data?.messages.map((m) => <PersistedMessage key={m.id} msg={m} />)}
                {inflight && <InflightAssistant inflight={inflight} />}
                {rateLimitNotice && (
                  <div className="rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-800">
                    {t('copilot.drawer.rateLimited', {
                      seconds: rateLimitNotice.retryAfterSeconds,
                    })}
                  </div>
                )}
                <div ref={scrollAnchorRef} />
              </div>

              <form
                onSubmit={handleSend}
                className="border-t border-edge bg-surface-0 px-4 py-3 flex gap-2"
              >
                <Textarea
                  ref={composerRef}
                  value={composerValue}
                  onChange={(e) => setComposerValue(e.target.value)}
                  onKeyDown={handleComposerKeydown}
                  placeholder={t('copilot.drawer.placeholder')}
                  rows={2}
                  maxLength={4000}
                  disabled={isStreaming}
                  className="resize-none"
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={isStreaming || composerValue.trim().length === 0}
                  aria-label={t('copilot.drawer.sendAria')}
                >
                  {isStreaming ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </form>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------

function CopilotWelcome() {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-edge bg-surface-1 p-4 text-sm text-text-secondary">
      <p className="font-medium text-text-primary">{t('copilot.drawer.welcome.title')}</p>
      <p className="mt-1">{t('copilot.drawer.welcome.body')}</p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-text-tertiary">
        {(t('copilot.drawer.welcome.examples', { returnObjects: true }) as string[]).map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

function PersistedMessage({ msg }: { msg: CopilotConversationMessage }) {
  if (msg.role === 'user') return <UserBubble msg={msg} />;
  return <AssistantBubble msg={msg} />;
}

function UserBubble({ msg }: { msg: CopilotUserMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary-600 px-3 py-2 text-sm text-white">
        {msg.content}
      </div>
    </div>
  );
}

function AssistantBubble({ msg }: { msg: CopilotAssistantMessage }) {
  const { t } = useTranslation();
  const outcomeSuffix = useMemo(() => {
    switch (msg.outcome) {
      case 'aborted':
        return t('copilot.drawer.outcome.aborted');
      case 'error':
        return t('copilot.drawer.outcome.error');
      case 'agent_loop_exceeded':
        return t('copilot.drawer.outcome.tooLong');
      case 'pending':
        // round 6 #4 — stale-pending detection deferred to backend
        // age check; here we show the placeholder.
        return t('copilot.drawer.outcome.interrupted');
      default:
        return null;
    }
  }, [msg.outcome, t]);
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-surface-1 px-3 py-2 text-sm text-text-primary whitespace-pre-wrap">
        {msg.content || t('copilot.drawer.outcome.empty')}
        {outcomeSuffix && (
          <span className="ml-2 text-xs italic text-text-tertiary">{outcomeSuffix}</span>
        )}
      </div>
      {msg.toolsCalled.length > 0 && (
        <div className="flex flex-wrap gap-1 pl-2">
          {msg.toolsCalled.map((b, i) => (
            <ToolBadge key={`${b.name}-${i}`} name={b.name} outcome={b.outcome} />
          ))}
        </div>
      )}
    </div>
  );
}

function InflightAssistant({ inflight }: { inflight: CopilotInflightTurn }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary-600 px-3 py-2 text-sm text-white">
          {inflight.userMessage}
        </div>
      </div>
      <div className="flex flex-col items-start gap-1">
        <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-surface-1 px-3 py-2 text-sm text-text-primary whitespace-pre-wrap">
          {inflight.assistant.content || (
            <span className="text-text-tertiary">{t('copilot.drawer.thinking')}</span>
          )}
          {inflight.assistant.outcome && inflight.assistant.outcome !== 'success' && (
            <span className="ml-2 text-xs italic text-text-tertiary">
              {inflight.assistant.outcome === 'aborted'
                ? t('copilot.drawer.outcome.aborted')
                : inflight.assistant.outcome === 'agent_loop_exceeded'
                  ? t('copilot.drawer.outcome.tooLong')
                  : t('copilot.drawer.outcome.error')}
            </span>
          )}
        </div>
        {inflight.assistant.toolBadges.length > 0 && (
          <div className="flex flex-wrap gap-1 pl-2">
            {inflight.assistant.toolBadges.map((b, i) => (
              <ToolBadge key={`inflight-${b.name}-${i}`} name={b.name} outcome={b.outcome} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function ToolBadge({
  name,
  outcome,
}: {
  name: string;
  outcome: 'success' | 'error' | 'in_flight';
}) {
  const { t } = useTranslation();
  const colorClass =
    outcome === 'error'
      ? 'bg-danger-50 text-danger-700 border-danger-200'
      : outcome === 'in_flight'
        ? 'bg-surface-2 text-text-tertiary border-edge'
        : 'bg-success-50 text-success-700 border-success-200';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide',
        colorClass,
      )}
      title={t('copilot.drawer.toolBadgeTooltip', { name })}
    >
      <Wrench className="h-3 w-3" />
      {name}
    </span>
  );
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

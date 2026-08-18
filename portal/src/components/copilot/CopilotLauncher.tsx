/**
 * Floating bottom-right launcher button.
 *
 * Locked-but-visible (Q9): every signed-in admin sees the launcher
 * regardless of tier. Essential admins see a small Pro lock badge;
 * clicking still opens the drawer, which then renders the
 * <CopilotLockedPreview /> inside.
 */
import { Bot, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { Button } from '@components/ui/button';
import { useHasFeature } from '../../queries/useEntitlementsQueries';
import { useCopilotDrawer } from './CopilotDrawerProvider';
import { cn } from '@/lib/utils';

export function CopilotLauncher() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { open, isOpen, suggestions, hasUnseenSuggestions } = useCopilotDrawer();
  const hasFeature = useHasFeature('platformAssistant');
  const label = !hasFeature
    ? t('copilot.launcher.tooltipLocked')
    : hasUnseenSuggestions
      ? t('copilot.launcher.tooltipWithSuggestions', { count: suggestions.length })
      : t('copilot.launcher.tooltip');

  if (isOpen) return null;
  // Inbox has its own bottom-right composer + Send button; the floating
  // launcher would sit on top of it, so hide it on that route.
  if (pathname.startsWith('/inbox')) return null;

  return (
    <Button
      onClick={open}
      title={label}
      aria-label={label}
      className={cn(
        'fixed bottom-5 right-5 z-40 h-12 w-12 rounded-full shadow-lg p-0',
        'bg-primary-600 text-white hover:bg-primary-700',
      )}
    >
      <Bot className="h-5 w-5" />
      {hasFeature && hasUnseenSuggestions && (
        <span
          aria-hidden
          className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-warning-500 px-1 text-[10px] text-white"
        >
          {suggestions.length}
        </span>
      )}
      {!hasFeature && (
        <span
          aria-hidden
          className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-warning-500 text-white text-[10px]"
        >
          <Lock className="h-3 w-3" />
        </span>
      )}
    </Button>
  );
}

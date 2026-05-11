import React from 'react';
import { useOrganization } from '@clerk/clerk-react';
import { Bot } from 'lucide-react';

export type ChatbotAppearancesPreviewProps = {
  primaryColor: string | null;
  avatarUrl: string | null;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string | null;
  greetingMessage: string;
};

const ChatbotAppearancesPreview: React.FC<ChatbotAppearancesPreviewProps> = ({
  primaryColor,
  avatarUrl,
  launcherPosition,
  launcherLabel,
  greetingMessage,
}) => {
  const { organization } = useOrganization();
  const effectivePrimary = primaryColor || '#6366f1';
  const effectiveAvatar = avatarUrl || organization?.imageUrl || null;
  const isPill = Boolean(launcherLabel);

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-6">
      <div className="relative h-96 overflow-hidden rounded-lg bg-background shadow-inner">
        {/* Open panel mock */}
        <div className="absolute inset-x-4 top-4 bottom-20 rounded-lg border border-border bg-card shadow-sm flex flex-col">
          <div
            className="flex items-center gap-3 rounded-t-lg px-4 py-3 text-white"
            style={{ backgroundColor: effectivePrimary }}
          >
            <div
              data-testid="preview-avatar"
              className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-white/20"
            >
              {effectiveAvatar ? (
                <img src={effectiveAvatar} alt="" className="h-full w-full object-cover" />
              ) : (
                <Bot className="h-4 w-4" />
              )}
            </div>
            <div className="text-sm font-medium">{organization?.name ?? 'Your Brand'}</div>
          </div>
          <div className="flex-1 px-4 py-3 space-y-2">
            {greetingMessage ? (
              <div
                data-testid="preview-greeting"
                className="max-w-[80%] rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
              >
                {greetingMessage}
              </div>
            ) : null}
          </div>
          <div className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            Type a message…
          </div>
        </div>

        {/* Closed launcher mock */}
        <button
          data-testid="preview-launcher"
          data-position={launcherPosition}
          className={[
            'absolute bottom-4 flex items-center gap-2 text-white shadow-lg transition',
            isPill ? 'preview-launcher--pill rounded-full px-4 py-2' : 'h-12 w-12 justify-center rounded-full',
            launcherPosition === 'bottom-left' ? 'left-4' : 'right-4',
          ].join(' ')}
          style={{ backgroundColor: effectivePrimary }}
          type="button"
        >
          <Bot className="h-5 w-5" />
          {isPill ? <span className="text-sm font-medium">{launcherLabel}</span> : null}
        </button>
      </div>
    </div>
  );
};

export default ChatbotAppearancesPreview;

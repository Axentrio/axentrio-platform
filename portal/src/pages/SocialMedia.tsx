/**
 * Social Media Page
 * Hub for the multi-channel surfaces (Facebook / Instagram / WhatsApp /
 * Telegram). v1 reuses the existing `SocialChannelsContent` component and
 * appends a "TikTok — Coming Soon" card per Deviation 29.
 *
 * Locked state: gated on `unifiedInbox` as a proxy for "is on a paid tier."
 */

import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { useHasFeature } from '../queries/useEntitlementsQueries';
import { LockedPreview } from '../components/billing/LockedPreview';
import { PlanBadge } from '../components/billing/PlanBadge';
import { NotifyMeButton } from '../components/billing/NotifyMeButton';
import { SocialChannelsContent } from '@/components/channels/SocialChannelsContent';

export default function SocialMedia() {
  const { t } = useTranslation();
  const hasUnifiedInbox = useHasFeature('unifiedInbox');

  if (!hasUnifiedInbox) {
    return (
      <LockedPreview
        feature="unifiedInbox"
        requiredTier="pro"
        title={t('socialMedia.locked.title')}
        oneLiner={t('socialMedia.locked.oneLiner')}
        bullets={[
          t('socialMedia.locked.bullets.1'),
          t('socialMedia.locked.bullets.2'),
          t('socialMedia.locked.bullets.3'),
        ]}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto flex flex-col gap-6 p-6 max-w-6xl mx-auto w-full">
      <SocialChannelsContent />

      {/* TikTok — Coming Soon, per Deviation 29 */}
      <Card className="p-6 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-base font-semibold text-text-primary">
              {t('socialMedia.tiktok.title')}
            </h3>
            <PlanBadge tier="comingSoon" />
          </div>
          <p className="text-sm text-text-secondary">
            {t('socialMedia.tiktok.description')}
          </p>
        </div>
        <NotifyMeButton feature="tiktok" />
      </Card>
    </div>
  );
}

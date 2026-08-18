/**
 * Social Media Page
 * Hub for connected and upcoming messaging channels.
 *
 * Locked state: gated on `unifiedInbox` as a proxy for "is on a paid tier."
 */

import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { useHasFeature } from '../queries/useEntitlementsQueries';
import { LockedPreview } from '../components/billing/LockedPreview';
import { PlanBadge } from '../components/billing/PlanBadge';
import { NotifyMeButton } from '../components/billing/NotifyMeButton';
import { FeatureDisabledNotice } from '../components/billing/FeatureDisabledNotice';
import { SocialChannelsContent } from '@/components/channels/SocialChannelsContent';

function UpcomingChannelCard({
  feature,
  label,
  description,
  enabled,
}: {
  feature: string;
  label: string;
  description: string;
  enabled: boolean;
}) {
  if (!enabled) return <FeatureDisabledNotice featureLabel={label} />;

  return (
    <Card className="p-6 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-base font-semibold text-text-primary">{label}</h3>
          <PlanBadge tier="comingSoon" />
        </div>
        <p className="text-sm text-text-secondary">{description}</p>
      </div>
      <NotifyMeButton feature={feature} />
    </Card>
  );
}

export default function SocialMedia() {
  const { t } = useTranslation();
  const hasUnifiedInbox = useHasFeature('unifiedInbox');
  const hasLinkedin = useHasFeature('channelLinkedin');
  const hasTiktok = useHasFeature('channelTiktok');
  const hasX = useHasFeature('channelX');

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

      <UpcomingChannelCard
        feature="linkedin"
        label={t('socialMedia.linkedin.title', { defaultValue: 'LinkedIn' })}
        description={t('socialMedia.linkedin.description', {
          defaultValue: 'LinkedIn messaging support is coming soon.',
        })}
        enabled={hasLinkedin}
      />
      <UpcomingChannelCard
        feature="tiktok"
        label={t('socialMedia.tiktok.title')}
        description={t('socialMedia.tiktok.description')}
        enabled={hasTiktok}
      />
      <UpcomingChannelCard
        feature="x"
        label={t('socialMedia.x.title', { defaultValue: 'X' })}
        description={t('socialMedia.x.description', {
          defaultValue: 'X direct-message support is coming soon.',
        })}
        enabled={hasX}
      />
    </div>
  );
}

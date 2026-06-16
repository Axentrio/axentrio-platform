/**
 * Shown when a tenant is ENTITLED to a feature but has turned it off via
 * Settings → Features. Distinct from <LockedPreview/> (which is the
 * not-entitled upsell): this is an opt-out state, never an upgrade prompt.
 *
 * Plan: .scratch/plan-tenant-feature-toggles.md § 5 / § 9b.1.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PowerOff } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface FeatureDisabledNoticeProps {
  /** Human label for the feature, e.g. "Bookings". */
  featureLabel: string;
}

export const FeatureDisabledNotice: React.FC<FeatureDisabledNoticeProps> = ({ featureLabel }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center p-6">
      <Card variant="glass" className="max-w-md w-full">
        <CardContent className="py-10 text-center space-y-4">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-3">
            <PowerOff className="h-6 w-6 text-text-muted" />
          </div>
          <div className="space-y-1">
            <p className="font-semibold text-text-primary">
              {t('features.disabled.title', { defaultValue: '{{feature}} is turned off', feature: featureLabel })}
            </p>
            <p className="text-sm text-text-secondary">
              {t('features.disabled.body', {
                defaultValue: 'Your plan includes this feature, but it has been switched off for your workspace.',
              })}
            </p>
          </div>
          <Button asChild size="sm">
            <Link to="/settings/features">
              {t('features.disabled.cta', { defaultValue: 'Manage features' })}
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

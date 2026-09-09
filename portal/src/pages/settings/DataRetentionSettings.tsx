/**
 * Data & retention.
 *
 * The one place a tenant can see and change how long the platform keeps their
 * customers' conversations. Deliberately a settings screen rather than an inbox
 * affordance: setting a period schedules irreversible deletion, so it should not
 * sit next to a day-to-day action.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ConversationRetentionCard } from '@/components/conversations/ConversationRetentionCard';
import { DeletionDangerZone } from '@/components/tenant/DeletionDangerZone';

const DataRetentionSettings: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-text-primary">
          {t('settings.retention.title', { defaultValue: 'Data & retention' })}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t('settings.retention.intro', {
            defaultValue:
              'How long we keep your customers\u2019 data. Nothing is deleted unless you choose a period here.',
          })}
        </p>
      </div>

      <ConversationRetentionCard />
      <DeletionDangerZone />
    </div>
  );
};

export default DataRetentionSettings;

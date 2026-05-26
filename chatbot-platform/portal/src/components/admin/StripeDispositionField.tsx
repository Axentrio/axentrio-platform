/**
 * Forced Stripe disposition for the manual tier-override dialog.
 *
 * A super-admin override to Free does NOT cancel an existing Stripe
 * subscription, so the customer would keep being charged behind a Free plan.
 * When a live Stripe sub exists, the admin must explicitly say what happens to
 * it (cancel / leave active + reason). Shown in both the AdminTenants list
 * dialog and the AdminTenantDetail dialog — keep them in sync via this field.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export type StripeDisposition = 'will_cancel' | 'leave_active';

/** True when the admin has made a complete, valid disposition choice. */
export function dispositionComplete(
  disposition: StripeDisposition | null,
  reason: string,
): boolean {
  if (!disposition) return false;
  if (disposition === 'leave_active' && !reason.trim()) return false;
  return true;
}

interface Props {
  disposition: StripeDisposition | null;
  onDispositionChange: (d: StripeDisposition) => void;
  reason: string;
  onReasonChange: (r: string) => void;
}

export const StripeDispositionField: React.FC<Props> = ({
  disposition,
  onDispositionChange,
  reason,
  onReasonChange,
}) => {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-3">
      <p className="text-sm text-amber-300 leading-relaxed">
        <strong>{t('admin.tenantDetail.tierDialog.disposition.title')}</strong>{' '}
        {t('admin.tenantDetail.tierDialog.disposition.explainer')}
      </p>
      <div className="space-y-2">
        {(['will_cancel', 'leave_active'] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onDispositionChange(opt)}
            className={cn(
              'w-full text-left rounded-lg border px-3 py-2 text-sm transition-colors',
              disposition === opt
                ? 'border-accent-500/60 bg-accent-500/10 text-text-primary'
                : 'border-edge hover:border-edge-strong hover:bg-surface-3 text-text-secondary',
            )}
          >
            {t(`admin.tenantDetail.tierDialog.disposition.${opt}`)}
          </button>
        ))}
      </div>
      {disposition === 'leave_active' && (
        <Textarea
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          placeholder={t('admin.tenantDetail.tierDialog.disposition.reasonPlaceholder')}
          rows={2}
          className="text-sm"
        />
      )}
    </div>
  );
};

/**
 * Step 3 — the logo.
 *
 * Uploads through Clerk's organization image, which is where the product already keeps
 * it (Settings → Widget & brand does the same). Storing it a second time on the tenant
 * would give the customer two logos that could disagree.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOrganization } from '@clerk/clerk-react';
import { ImagePlus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import type { StepProps } from './types';

export function LogoStep({ submit }: StepProps) {
  const { t } = useTranslation();
  const { organization } = useOrganization();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = React.useState(false);

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !organization) return;
    setUploading(true);
    try {
      await organization.setLogo({ file });
      submit.mutate({ step: 'logo' });
    } catch {
      toast.error(t('setup.steps.logo.uploadFailed'));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const busy = uploading || submit.isPending;

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-text-primary">{t('setup.steps.logo.title')}</h2>
        <p className="text-sm text-text-secondary">{t('setup.steps.logo.body')}</p>
      </div>

      <div className="flex items-center gap-5 rounded-xl border border-edge bg-surface-2 p-5">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-surface">
          {organization?.imageUrl ? (
            <img src={organization.imageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImagePlus className="h-6 w-6 text-text-muted" />
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            onChange={upload}
            className="hidden"
          />
          <Button variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('setup.steps.logo.choose')}
          </Button>
          <p className="text-xs text-text-muted">{t('setup.steps.logo.hint')}</p>
        </div>
      </div>
    </div>
  );
}

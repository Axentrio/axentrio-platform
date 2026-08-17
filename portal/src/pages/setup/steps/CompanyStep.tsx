/**
 * Step 2 — the company.
 *
 * The VAT number does the typing: one lookup against the EU register fills the name and
 * address, so the customer confirms rather than transcribes.
 *
 * The register is slow (measured at 3–8 seconds) and sometimes down, and NEITHER may stop
 * someone signing up. So every outcome lands the customer in the same place — a form they
 * can edit and submit — and the four statuses differ only in how much was filled in for
 * them and what the screen says about it.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, CheckCircle2, Loader2, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  useCompanyLookup,
  type CompanyLookupStatus,
  type SetupStatus,
} from '@/queries/useOnboardingQueries';
import type { StepProps } from './types';

interface Fields {
  name: string;
  legalForm: string;
  street: string;
  postalCode: string;
  city: string;
}

const EMPTY: Fields = { name: '', legalForm: '', street: '', postalCode: '', city: '' };

export function CompanyStep({ status, submit }: StepProps & { status: SetupStatus }) {
  const { t } = useTranslation();
  const lookup = useCompanyLookup();
  const stored = status.state.company;

  const [vat, setVat] = React.useState(stored?.vatNumber ?? '');
  const [fields, setFields] = React.useState<Fields>(
    stored
      ? {
          name: stored.name,
          legalForm: stored.legalForm ?? '',
          street: stored.street ?? '',
          postalCode: stored.postalCode ?? '',
          city: stored.city ?? '',
        }
      : EMPTY,
  );
  const [outcome, setOutcome] = React.useState<CompanyLookupStatus | null>(null);
  const [verified, setVerified] = React.useState(stored?.verified ?? false);
  const [presence, setPresence] = React.useState<'online' | 'physical' | ''>(
    stored?.presence === 'physical' || stored?.presence === 'online' ? stored.presence : '',
  );

  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  const runLookup = async () => {
    if (!vat.trim()) return;
    const result = await lookup.mutateAsync(vat.trim());
    setOutcome(result.status);
    setVerified(result.status === 'found');
    if (result.company) {
      setFields({
        name: result.company.name,
        legalForm: result.company.legalForm ?? '',
        street: result.company.street ?? '',
        postalCode: result.company.postalCode ?? '',
        city: result.company.city ?? '',
      });
    }
  };

  const save = () =>
    submit.mutate({
      step: 'company',
      company: {
        vatNumber: vat.trim(),
        name: fields.name.trim(),
        legalForm: fields.legalForm.trim() || null,
        street: fields.street.trim() || null,
        postalCode: fields.postalCode.trim() || null,
        city: fields.city.trim() || null,
        presence: presence || undefined,
      },
    });

  const canSave =
    vat.trim().length > 0 && fields.name.trim().length > 0 && !!presence && !submit.isPending;

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-text-primary">{t('setup.steps.company.title')}</h2>
        <p className="text-sm text-text-secondary">{t('setup.steps.company.body')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="setup-vat">{t('setup.steps.company.vatLabel')}</Label>
        <div className="flex gap-2">
          <Input
            id="setup-vat"
            value={vat}
            onChange={(e) => setVat(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runLookup()}
            placeholder="BE 0400.378.485"
            autoComplete="off"
          />
          <Button
            type="button"
            variant="outline"
            onClick={runLookup}
            disabled={!vat.trim() || lookup.isPending}
            className="shrink-0 gap-2"
          >
            {lookup.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Search className="h-4 w-4" />
            )}
            {t('setup.steps.company.lookup')}
          </Button>
        </div>
        {/* The wait is long enough to need saying out loud. */}
        {lookup.isPending && (
          <p className="text-xs text-text-muted">{t('setup.steps.company.lookingUp')}</p>
        )}
        {outcome && !lookup.isPending && (
          <p
            className={
              outcome === 'found' ? 'flex items-center gap-1.5 text-xs text-status-online' : 'text-xs text-text-muted'
            }
          >
            {outcome === 'found' && <CheckCircle2 className="h-3.5 w-3.5" />}
            {t(`setup.steps.company.lookupStatus.${outcome}`)}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="setup-name">{t('setup.steps.company.nameLabel')}</Label>
          <Input id="setup-name" value={fields.name} onChange={set('name')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="setup-legal-form">{t('setup.steps.company.legalFormLabel')}</Label>
          <Input
            id="setup-legal-form"
            value={fields.legalForm}
            onChange={set('legalForm')}
            placeholder="BV, NV, SRL…"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="setup-street">{t('setup.steps.company.streetLabel')}</Label>
          <Input id="setup-street" value={fields.street} onChange={set('street')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="setup-postal">{t('setup.steps.company.postalCodeLabel')}</Label>
          <Input id="setup-postal" value={fields.postalCode} onChange={set('postalCode')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="setup-city">{t('setup.steps.company.cityLabel')}</Label>
          <Input id="setup-city" value={fields.city} onChange={set('city')} />
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-text-secondary">{t('setup.steps.company.presence.label')}</legend>
        <p className="text-xs text-text-muted">{t('setup.steps.company.presence.helper')}</p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="setup-presence"
            value="physical"
            checked={presence === 'physical'}
            onChange={() => setPresence('physical')}
          />
          <span className="text-sm text-text-primary">{t('setup.steps.company.presence.physical')}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="radio"
            name="setup-presence"
            value="online"
            checked={presence === 'online'}
            onChange={() => setPresence('online')}
          />
          <span className="text-sm text-text-primary">{t('setup.steps.company.presence.online')}</span>
        </label>
      </fieldset>

      <div className="flex items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <Building2 className="h-3.5 w-3.5" />
          {verified
            ? t('setup.steps.company.verifiedNote')
            : t('setup.steps.company.unverifiedNote')}
        </p>
        <Button onClick={save} disabled={!canSave} size="lg">
          {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t('setup.continue')}
        </Button>
      </div>
    </div>
  );
}

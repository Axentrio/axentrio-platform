/**
 * Account Information — tenant invoice identity (#148).
 *
 * Distinct from Profile (the signed-in Clerk user). Official name / VAT /
 * registered address prefill from onboarding; invoice email prefills from
 * billingInfo.billingEmail. Phone is optional.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2, Save, Check, Loader2 } from 'lucide-react';
import { api, extractApiErrorMessage } from '@services/apiClient';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface InvoiceAddress {
  street: string;
  streetNumber: string;
  boxNumber: string;
  postalCode: string;
  city: string;
  country: string;
}

export interface AccountInformation {
  officialBusinessName: string;
  vatNumber: string;
  contactPerson: string;
  invoiceAddress: InvoiceAddress;
  invoiceEmail: string;
  phone: string | null;
  vatVerified: boolean;
}

const empty: AccountInformation = {
  officialBusinessName: '',
  vatNumber: '',
  contactPerson: '',
  invoiceAddress: { street: '', streetNumber: '', boxNumber: '', postalCode: '', city: '', country: 'BE' },
  invoiceEmail: '',
  phone: null,
  vatVerified: false,
};

const AccountInformationSettings: React.FC = () => {
  const { t } = useTranslation();
  const [form, setForm] = useState<AccountInformation>(empty);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<AccountInformation>('/tenants/me/account');
        if (!cancelled && data) setForm({ ...empty, ...data, invoiceAddress: { ...empty.invoiceAddress, ...data.invoiceAddress } });
      } catch {
        // Non-fatal — leave the form empty so the owner can still type.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const set = <K extends keyof AccountInformation>(key: K, value: AccountInformation[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

  const setAddr = (key: keyof InvoiceAddress, value: string) => {
    setForm((prev) => ({ ...prev, invoiceAddress: { ...prev.invoiceAddress, [key]: value } }));
    setErrors((prev) => {
      const { [`invoiceAddress.${key}`]: _drop, ...rest } = prev;
      return rest;
    });
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!form.officialBusinessName.trim()) next.officialBusinessName = t('settings.account.validation.required');
    if (!form.vatNumber.trim()) next.vatNumber = t('settings.account.validation.required');
    if (!form.contactPerson.trim()) next.contactPerson = t('settings.account.validation.required');
    if (!form.invoiceEmail.trim()) next.invoiceEmail = t('settings.account.validation.required');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.invoiceEmail)) next.invoiceEmail = t('settings.account.validation.email');
    if (!form.invoiceAddress.street.trim()) next['invoiceAddress.street'] = t('settings.account.validation.required');
    if (!form.invoiceAddress.postalCode.trim()) next['invoiceAddress.postalCode'] = t('settings.account.validation.required');
    if (!form.invoiceAddress.city.trim()) next['invoiceAddress.city'] = t('settings.account.validation.required');
    if (!/^[A-Za-z]{2}$/.test(form.invoiceAddress.country.trim())) {
      next['invoiceAddress.country'] = t('settings.account.validation.country');
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const savedRow = await api.put<AccountInformation>('/tenants/me/account', {
        officialBusinessName: form.officialBusinessName.trim(),
        vatNumber: form.vatNumber.trim(),
        contactPerson: form.contactPerson.trim(),
        invoiceAddress: form.invoiceAddress,
        invoiceEmail: form.invoiceEmail.trim(),
        phone: form.phone?.trim() || null,
      });
      if (savedRow) setForm({ ...empty, ...savedRow, invoiceAddress: { ...empty.invoiceAddress, ...savedRow.invoiceAddress } });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      toast.error(extractApiErrorMessage(err) ?? t('settings.account.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {saved && (
        <div className="p-4 bg-status-online/10 border border-status-online/20 rounded-xl flex items-center gap-2 text-status-online">
          <Check className="w-5 h-5" />
          {t('common.saved')}
        </div>
      )}

      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Building2 className="w-5 h-5" />
            {t('settings.account.title')}
          </h2>
          <p className="text-sm text-text-muted mt-1">{t('settings.account.helper')}</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <Field
              id="officialBusinessName"
              label={t('settings.account.officialBusinessName')}
              required
              value={form.officialBusinessName}
              onChange={(v) => set('officialBusinessName', v)}
              error={errors.officialBusinessName}
              disabled={saving}
            />
            <Field
              id="vatNumber"
              label={t('settings.account.vatNumber')}
              required
              value={form.vatNumber}
              onChange={(v) => set('vatNumber', v)}
              error={errors.vatNumber}
              disabled={saving}
              hint={form.vatVerified ? t('settings.account.vatVerified') : t('settings.account.vatHint')}
            />
            <Field
              id="contactPerson"
              label={t('settings.account.contactPerson')}
              required
              value={form.contactPerson}
              onChange={(v) => set('contactPerson', v)}
              error={errors.contactPerson}
              disabled={saving}
            />
            <Field
              id="invoiceEmail"
              label={t('settings.account.invoiceEmail')}
              required
              type="email"
              value={form.invoiceEmail}
              onChange={(v) => set('invoiceEmail', v)}
              error={errors.invoiceEmail}
              disabled={saving}
            />
            <Field
              id="phone"
              label={t('settings.account.phone')}
              value={form.phone ?? ''}
              onChange={(v) => set('phone', v)}
              disabled={saving}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field
                id="street"
                label={t('settings.account.street')}
                required
                value={form.invoiceAddress.street}
                onChange={(v) => setAddr('street', v)}
                error={errors['invoiceAddress.street']}
                disabled={saving}
              />
              <Field
                id="streetNumber"
                label={t('settings.account.streetNumber')}
                value={form.invoiceAddress.streetNumber}
                onChange={(v) => setAddr('streetNumber', v)}
                disabled={saving}
              />
              <Field
                id="boxNumber"
                label={t('settings.account.boxNumber')}
                value={form.invoiceAddress.boxNumber}
                onChange={(v) => setAddr('boxNumber', v)}
                disabled={saving}
              />
              <Field
                id="country"
                label={t('settings.account.country')}
                required
                value={form.invoiceAddress.country}
                onChange={(v) => setAddr('country', v.toUpperCase())}
                error={errors['invoiceAddress.country']}
                disabled={saving}
                maxLength={2}
                placeholder="BE"
              />
              <Field
                id="postalCode"
                label={t('settings.account.postalCode')}
                required
                value={form.invoiceAddress.postalCode}
                onChange={(v) => setAddr('postalCode', v)}
                error={errors['invoiceAddress.postalCode']}
                disabled={saving}
              />
              <Field
                id="city"
                label={t('settings.account.city')}
                required
                value={form.invoiceAddress.city}
                onChange={(v) => setAddr('city', v)}
                error={errors['invoiceAddress.city']}
                disabled={saving}
              />
            </div>

            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                {t('common.save')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

const Field: React.FC<{
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
  error?: string;
  disabled?: boolean;
  hint?: string;
  maxLength?: number;
  placeholder?: string;
}> = ({ id, label, value, onChange, required, type = 'text', error, disabled, hint, maxLength, placeholder }) => (
  <div className="space-y-1">
    <Label htmlFor={id} className="text-text-secondary">
      {label} {required && <span className="text-red-500">*</span>}
    </Label>
    <Input
      id={id}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      className={error ? 'border-red-500' : ''}
    />
    {error && <p className="text-xs text-red-500">{error}</p>}
    {hint && !error && <p className="text-xs text-text-muted">{hint}</p>}
  </div>
);

export default AccountInformationSettings;

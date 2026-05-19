/**
 * Profile Settings
 * User profile information and password management
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { User, Lock, Mail, Save, Check, Loader2, Globe } from 'lucide-react';
import { useAppAuth, useUser } from '@auth/useAppAuth';
import { api } from '@services/apiClient';
import { toast } from 'sonner';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import i18n, {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  isSupportedLocale,
  type SupportedLocale,
} from '@/i18n';

const ProfileSettings: React.FC = () => {
  const { user } = useAppAuth();
  const { user: clerkUser } = useUser();
  const { t } = useTranslation();

  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [profileData, setProfileData] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    email: user?.email || '',
  });

  // Locale is its own concern — loaded from the server on mount and committed
  // independently of the name fields so changing language is a single click.
  const [locale, setLocale] = useState<SupportedLocale>(() =>
    isSupportedLocale(i18n.language) ? i18n.language : DEFAULT_LOCALE,
  );
  const [isLocaleSaving, setIsLocaleSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api.get<{ profile?: { locale?: string } }>('/users/profile');
        const serverLocale = response?.profile?.locale;
        if (!cancelled && isSupportedLocale(serverLocale)) {
          setLocale(serverLocale);
          if (i18n.language !== serverLocale) i18n.changeLanguage(serverLocale);
        }
      } catch {
        // Non-fatal — fall back to current i18n language.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    if (!profileData.firstName.trim()) next.firstName = 'First name is required';
    if (!profileData.lastName.trim()) next.lastName = 'Last name is required';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSaveProfile = async () => {
    if (!clerkUser || !validate()) return;
    setIsSaving(true);
    try {
      await clerkUser.update({
        firstName: profileData.firstName,
        lastName: profileData.lastName,
      });
      const fullName = [profileData.firstName, profileData.lastName].filter(Boolean).join(' ');
      await api.patch('/users/profile', { name: fullName });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch {
      toast.error('Failed to save profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLocaleChange = async (next: string) => {
    if (!isSupportedLocale(next) || next === locale) return;
    const previous = locale;
    setLocale(next);
    i18n.changeLanguage(next);
    setIsLocaleSaving(true);
    try {
      await api.patch('/users/profile', { locale: next });
    } catch {
      // Roll back local state if the server rejected the change.
      setLocale(previous);
      i18n.changeLanguage(previous);
      toast.error('Failed to save language preference.');
    } finally {
      setIsLocaleSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {saveSuccess && (
        <div className="p-4 bg-status-online/10 border border-status-online/20 rounded-xl flex items-center gap-2 text-status-online">
          <Check className="w-5 h-5" />
          Settings saved successfully!
        </div>
      )}

      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <User className="w-5 h-5" />
            Profile Information
          </h2>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label htmlFor="firstName" className="text-text-secondary">First Name <span className="text-red-500">*</span></Label>
                <Input
                  id="firstName"
                  type="text"
                  value={profileData.firstName}
                  onChange={(e) => { setProfileData({ ...profileData, firstName: e.target.value }); setErrors((prev) => { const { firstName: _, ...rest } = prev; return rest; }); }}
                  disabled={isSaving}
                  className={errors.firstName ? 'border-red-500' : ''}
                />
                {errors.firstName && <p className="text-xs text-red-500">{errors.firstName}</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="lastName" className="text-text-secondary">Last Name <span className="text-red-500">*</span></Label>
                <Input
                  id="lastName"
                  type="text"
                  value={profileData.lastName}
                  onChange={(e) => { setProfileData({ ...profileData, lastName: e.target.value }); setErrors((prev) => { const { lastName: _, ...rest } = prev; return rest; }); }}
                  disabled={isSaving}
                  className={errors.lastName ? 'border-red-500' : ''}
                />
                {errors.lastName && <p className="text-xs text-red-500">{errors.lastName}</p>}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="email" className="text-text-secondary">Email</Label>
              <div className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-text-muted" />
                <Input
                  id="email"
                  type="email"
                  value={profileData.email}
                  disabled
                  className="flex-1"
                />
              </div>
              <p className="text-xs text-text-muted">Email cannot be changed</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSaveProfile} disabled={isSaving}>
                {isSaving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                Save Changes
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Globe className="w-5 h-5" />
            {t('settings.profile.preferences.title')}
          </h2>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-w-sm">
            <Label htmlFor="locale" className="text-text-secondary">
              {t('settings.profile.preferences.language.label')}
            </Label>
            <Select value={locale} onValueChange={handleLocaleChange} disabled={isLocaleSaving}>
              <SelectTrigger id="locale" aria-label="Language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPORTED_LOCALES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {t(`settings.profile.preferences.language.options.${code}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">
              {t('settings.profile.preferences.language.helper')}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Lock className="w-5 h-5" />
            Password
          </h2>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-text-secondary">
            Your password is managed by Clerk. To change your password, use the Clerk user menu or visit your Clerk account settings.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

export default ProfileSettings;

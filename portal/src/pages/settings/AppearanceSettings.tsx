/**
 * Appearance Settings
 * Theme switcher with mini previews
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Paintbrush } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';

type ThemeMode = 'light' | 'dark' | 'system';

/** Mini app preview for the theme cards */
const ThemePreview: React.FC<{ mode: 'light' | 'dark' | 'system' }> = ({ mode }) => {
  if (mode === 'system') {
    return (
      <div className="w-full h-16 rounded-lg overflow-hidden flex">
        <div className="w-1/2 bg-[#f8f9fb] flex">
          <div className="w-[35%] bg-white border-r border-[#e5e7eb]" />
          <div className="flex-1 p-1.5">
            <div className="h-1.5 bg-[#e5e7eb] rounded w-3/5 mb-1" />
            <div className="h-1 bg-[#f0f0f0] rounded w-4/5" />
          </div>
        </div>
        <div className="w-1/2 bg-[#0f1117] flex">
          <div className="flex-1 p-1.5">
            <div className="h-1.5 bg-[rgba(255,255,255,0.1)] rounded w-3/5 mb-1" />
            <div className="h-1 bg-[rgba(255,255,255,0.05)] rounded w-4/5" />
          </div>
          <div className="w-[35%] bg-[#0a0b0f] border-l border-[rgba(255,255,255,0.05)]" />
        </div>
      </div>
    );
  }

  const isLight = mode === 'light';
  return (
    <div className={cn('w-full h-16 rounded-lg overflow-hidden flex', isLight ? 'bg-[#f8f9fb]' : 'bg-[#0f1117]')}>
      <div className={cn('w-[35%]', isLight ? 'bg-white border-r border-[#e5e7eb]' : 'bg-[#0a0b0f] border-r border-[rgba(255,255,255,0.05)]')} />
      <div className="flex-1 p-1.5">
        <div className={cn('h-1.5 rounded w-3/5 mb-1', isLight ? 'bg-[#e5e7eb]' : 'bg-[rgba(255,255,255,0.1)]')} />
        <div className={cn('h-1 rounded w-4/5', isLight ? 'bg-[#f0f0f0]' : 'bg-[rgba(255,255,255,0.05)]')} />
      </div>
    </div>
  );
};

const AppearanceSettings: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const themeModes: ThemeMode[] = ['light', 'dark', 'system'];

  return (
    <div className="space-y-6">
      {/* Theme */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Paintbrush className="w-5 h-5" />
            {t('settings.appearance.title')}
          </h2>
          <p className="text-sm text-text-secondary">{t('settings.appearance.description')}</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {themeModes.map((mode) => (
              <button
                type="button"
                key={mode}
                onClick={() => setTheme(mode)}
                className={cn(
                  'p-3 rounded-xl border-2 text-center transition-all cursor-pointer',
                  theme === mode
                    ? 'border-primary-500 bg-primary-600/10'
                    : 'border-edge hover:border-edge-light'
                )}
              >
                <ThemePreview mode={mode} />
                <p className="mt-2 text-sm font-medium text-text-primary">{t(`settings.appearance.options.${mode}`)}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default AppearanceSettings;

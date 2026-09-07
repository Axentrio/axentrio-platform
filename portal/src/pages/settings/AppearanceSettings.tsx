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

/**
 * Mini app preview.
 *
 * Nested `.light` / `.dark` so the pane reads the SAME CSS variables as the
 * rest of the product — a preview of the other mode cannot use live tokens
 * from <html>, but it can opt that subtree into the other scheme. No hex.
 */
const PreviewPane: React.FC<{ scheme: 'light' | 'dark'; className?: string }> = ({
  scheme,
  className,
}) => (
  <div className={cn(scheme, 'flex h-full bg-surface-0', className)}>
    <div className="w-[35%] border-r border-sidebar-border bg-sidebar" />
    <div className="flex-1 space-y-1 p-1.5">
      <div className="h-1.5 w-3/5 rounded bg-edge" />
      <div className="h-1 w-4/5 rounded bg-surface-3" />
      <div className="h-1 w-2/5 rounded bg-primary-400" />
    </div>
  </div>
);

const ThemePreview: React.FC<{ mode: ThemeMode }> = ({ mode }) => (
  <div className="flex h-16 w-full overflow-hidden rounded-lg border border-edge">
    {mode === 'system' ? (
      <>
        <PreviewPane scheme="light" className="w-1/2" />
        <PreviewPane scheme="dark" className="w-1/2" />
      </>
    ) : (
      <PreviewPane scheme={mode} className="w-full" />
    )}
  </div>
);

const themeModes: ThemeMode[] = ['light', 'dark', 'system'];

const AppearanceSettings: React.FC = () => {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Paintbrush className="w-5 h-5" />
            {t('settings.appearance.title')}
          </h2>
          <p className="text-sm text-text-secondary">{t('settings.appearance.description')}</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {themeModes.map((mode) => (
              <button
                type="button"
                key={mode}
                onClick={() => setTheme(mode)}
                className={cn(
                  'p-3 rounded-xl border-2 text-center transition-all cursor-pointer',
                  theme === mode
                    ? 'border-primary-500 bg-primary-600/10'
                    : 'border-edge hover:border-edge-light',
                )}
              >
                <ThemePreview mode={mode} />
                <p className="mt-2 text-sm font-medium text-text-primary">
                  {t(`settings.appearance.options.${mode}`)}
                </p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default AppearanceSettings;

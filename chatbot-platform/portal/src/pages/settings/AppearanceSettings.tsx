/**
 * Appearance Settings
 * Theme switcher with mini previews and accent color picker
 */

import React, { useState } from 'react';
import { Paintbrush, Check } from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type ThemeMode = 'light' | 'dark' | 'system';

const PRESET_COLORS = [
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Cyan', hex: '#06b6d4' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Blue', hex: '#3b82f6' },
];

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
  const { theme, setTheme, accent, accentSource, setAccent } = useTheme();
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customHex, setCustomHex] = useState(accent);

  const themeOptions: { mode: ThemeMode; label: string }[] = [
    { mode: 'light', label: 'Light' },
    { mode: 'dark', label: 'Dark' },
    { mode: 'system', label: 'System' },
  ];

  const isOrgBranded = accentSource === 'org';

  const handleCustomColorApply = () => {
    const hex = customHex.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      setAccent(hex);
    }
  };

  return (
    <div className="space-y-6">
      {/* Theme */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Paintbrush className="w-5 h-5" />
            Theme
          </h2>
          <p className="text-sm text-text-secondary">Choose your preferred theme</p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4">
            {themeOptions.map(({ mode, label }) => (
              <button
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
                <p className="mt-2 text-sm font-medium text-text-primary">{label}</p>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Accent Color */}
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Paintbrush className="w-5 h-5" />
            Accent Color
          </h2>
          <p className="text-sm text-text-secondary">
            {isOrgBranded
              ? "Your organization's branding is applied"
              : 'Pick your primary accent color'}
          </p>
        </CardHeader>
        <CardContent>
          <div className={cn(isOrgBranded && 'opacity-50 pointer-events-none')}>
            <div className="flex items-center gap-3 flex-wrap">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color.hex}
                  onClick={() => {
                    setAccent(color.hex);
                    setShowCustomInput(false);
                  }}
                  className={cn(
                    'w-9 h-9 rounded-full transition-all relative',
                    accent === color.hex && !showCustomInput
                      ? 'ring-2 ring-offset-2 ring-offset-surface-1 ring-primary-500 scale-110'
                      : 'hover:scale-105'
                  )}
                  style={{ backgroundColor: color.hex }}
                  title={color.name}
                >
                  {accent === color.hex && !showCustomInput && (
                    <Check className="w-4 h-4 text-white absolute inset-0 m-auto" />
                  )}
                </button>
              ))}

              {/* Divider */}
              <div className="w-px h-6 bg-edge mx-1" />

              {/* Custom color button */}
              <button
                onClick={() => setShowCustomInput(!showCustomInput)}
                className={cn(
                  'w-9 h-9 rounded-full transition-all',
                  'bg-[conic-gradient(red,yellow,lime,aqua,blue,magenta,red)]',
                  showCustomInput
                    ? 'ring-2 ring-offset-2 ring-offset-surface-1 ring-primary-500 scale-110'
                    : 'hover:scale-105'
                )}
                title="Custom color"
              />
            </div>

            {showCustomInput && (
              <div className="mt-4 flex items-center gap-3">
                <div
                  className="w-9 h-9 rounded-lg border border-edge flex-shrink-0"
                  style={{ backgroundColor: customHex }}
                />
                <div className="flex-1">
                  <Label className="text-text-secondary text-xs mb-1 block">Hex Color</Label>
                  <Input
                    value={customHex}
                    onChange={(e) => setCustomHex(e.target.value)}
                    onBlur={handleCustomColorApply}
                    onKeyDown={(e) => e.key === 'Enter' && handleCustomColorApply()}
                    placeholder="#6366f1"
                    className="font-mono text-sm"
                  />
                </div>
              </div>
            )}
          </div>

          {isOrgBranded && (
            <p className="text-xs text-text-muted mt-3 italic">
              Accent color is managed by your organization's branding settings.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default AppearanceSettings;

import { useEffect } from 'react';
import { useTenantSettings } from '@/queries/useTenantQueries';

const DEFAULT_COLOR = '#6366f1';
const HEX_REGEX = /^#[0-9a-fA-F]{6}$/;

/** Convert a hex color string to HSL components { h, s, l } */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return { h: 0, s: 0, l: l * 100 };

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** Convert HSL components back to a hex string */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = ln - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Generate a full primary palette from a base hex color */
function generatePalette(baseHex: string) {
  const { h, s } = hexToHsl(baseHex);

  // Lightness steps tuned for dark UI surfaces
  const steps: Record<string, number> = {
    50: 95, 100: 90, 200: 82, 300: 71,
    400: 60, 500: 50, 600: 42, 700: 33,
    800: 24, 900: 17,
  };

  const palette: Record<string, string> = {};
  for (const [step, lightness] of Object.entries(steps)) {
    palette[step] = hslToHex(h, Math.min(s, 90), lightness);
  }

  return { palette, h, s };
}

/**
 * Reads the tenant's primaryColor from settings and applies
 * a generated color palette as CSS custom properties.
 */
export function useTenantTheme() {
  const { data } = useTenantSettings();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawColor = (data as any)?.settings?.theme?.primaryColor;
  const baseColor = typeof rawColor === 'string' && HEX_REGEX.test(rawColor)
    ? rawColor
    : DEFAULT_COLOR;

  useEffect(() => {
    const root = document.documentElement;
    const { palette, h, s } = generatePalette(baseColor);

    // Set numbered scale
    for (const [step, hex] of Object.entries(palette)) {
      root.style.setProperty(`--color-primary-${step}`, hex);
    }

    // Set RGB for glow shadows (from the 500 step)
    const r500 = parseInt(palette['500'].slice(1, 3), 16);
    const g500 = parseInt(palette['500'].slice(3, 5), 16);
    const b500 = parseInt(palette['500'].slice(5, 7), 16);
    root.style.setProperty('--color-primary-rgb', `${r500}, ${g500}, ${b500}`);

    // Set shadcn HSL tokens (format: "H S% L%")
    root.style.setProperty('--primary', `${h} ${Math.min(s, 90)}% 50%`);
    root.style.setProperty('--ring', `${h} ${Math.min(s, 90)}% 60%`);

    return () => {
      const vars = [
        ...Object.keys(palette).map((step) => `--color-primary-${step}`),
        '--color-primary-rgb', '--primary', '--ring',
      ];
      vars.forEach((v) => root.style.removeProperty(v));
    };
  }, [baseColor]);
}

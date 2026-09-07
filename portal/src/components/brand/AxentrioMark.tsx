import { cn } from '@/lib/utils';

type AxentrioMarkProps = {
  className?: string;
  title?: string;
  variant?: 'onLight' | 'onDark';
};

const FILLS = {
  onLight: {
    rightOuter: '#123B3A',
    leftOuter: '#0C1112',
    leftInner: '#123B3A',
    teal: '#2dd4bf',
  },
  onDark: {
    rightOuter: '#4E7B75',
    leftOuter: '#F2F0E9',
    leftInner: '#4E7B75',
    teal: '#2dd4bf',
  },
} as const;

/** Four-face A from the Axentrio brand mark. */
export function AxentrioMark({
  className,
  title = 'Axentrio',
  variant = 'onLight',
}: AxentrioMarkProps) {
  const fill = FILLS[variant];
  return (
    <svg
      viewBox="0 0 220 176"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('block', className)}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <polygon fill={fill.rightOuter} points="176,166 206,166 144,10 114,10" />
      <polygon fill={fill.leftOuter} points="6,166 36,166 92,10 62,10" />
      <polygon fill={fill.leftInner} points="28,166 58,166 114,10 84,10" />
      <polygon fill={fill.teal} points="148,166 178,166 128,10 98,10" />
    </svg>
  );
}

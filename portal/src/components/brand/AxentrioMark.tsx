import { cn } from '@/lib/utils';

type AxentrioMarkProps = {
  className?: string;
  title?: string;
  /** Ribbon emblem for compact chrome, or full wordmark for auth/marketing. */
  kind?: 'mark' | 'full';
  /** Dark ink on light surfaces, or light ink on dark portal chrome. */
  variant?: 'onLight' | 'onDark';
};

/** Tuned SVG exports (transparent bg, tight viewBox). */
const ASSETS = {
  mark: {
    onLight: '/axentrio-mark.svg',
    onDark: '/axentrio-mark-on-dark.svg',
  },
  full: {
    onLight: '/axentrio-wordmark.svg',
    onDark: '/axentrio-wordmark-on-dark.svg',
  },
} as const;

/** Axentrio brand logo from the official SVG mark. */
export function AxentrioMark({
  className,
  title = 'Axentrio',
  kind = 'mark',
  variant = 'onDark',
}: AxentrioMarkProps) {
  return (
    <img
      src={ASSETS[kind][variant]}
      alt={title}
      className={cn(
        'block object-contain',
        kind === 'full' ? 'h-14 w-auto' : 'h-8 w-auto',
        className,
      )}
      draggable={false}
    />
  );
}

/** Full Axentrio wordmark (emblem + lettering). */
export function AxentrioLogo({
  className,
  title = 'Axentrio',
  variant = 'onDark',
}: Omit<AxentrioMarkProps, 'kind'>) {
  return (
    <AxentrioMark className={className} title={title} kind="full" variant={variant} />
  );
}

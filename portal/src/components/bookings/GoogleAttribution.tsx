/**
 * Google attribution, required on every surface that shows a Google-derived drive or position.
 *
 * NOT A DESIGN CHOICE. ADR-0014 takes on Google Maps Platform as a paid dependency, and the
 * Maps terms require attribution wherever their content is displayed. A surface that shows a
 * drive time, a distance, or a reachability verdict derived from one without this is a licence
 * breach, not an untidy screen.
 *
 * THE TEXT FORM, NOT THE LOGO. Google permits either a logo between 16 and 19dp with defined
 * clear space and no modification, or the text form. The logo would mean embedding an official
 * asset and honouring its clear-space rules inside a table row; the text form is the same
 * permission with far less that can silently go out of spec.
 *
 * CONTRAST IS MEASURED, NOT EYEballed — the terms require a minimum against whatever it sits
 * on, and the first version of this file failed it in both themes while looking perfectly fine.
 * Against `--color-surface-1`:
 *
 *   token            light   dark
 *   text-muted        2.54    3.97   ← what this used to use. Fails 4.5:1 in both, and 3:1 in light.
 *   text-secondary    4.83    7.55   ← passes 4.5:1 in both. Use this.
 *
 * So the colour is `text-text-secondary` and it is not a matter of taste. Re-run the numbers
 * before changing it; a value that passes in light and vanishes in dark fails the same rule.
 *
 * TYPEFACE AND WEIGHT ARE STATED, not inherited. Google's specification names both for the
 * text form; loading Roboto is optional and the product's own sans-serif fallback is permitted,
 * so `font-sans font-normal` pins weight 400 and the permitted stack explicitly. Written down
 * rather than left to cascade, because "whatever the parent had" is not a decision anyone can
 * check, and a heading or a muted block could silently change either.
 */
export function GoogleAttribution({ className }: { className?: string }) {
  return (
    <span
      className={`font-sans text-xs font-normal leading-none text-text-secondary ${className ?? ''}`}
    >
      Powered by Google
    </span>
  );
}

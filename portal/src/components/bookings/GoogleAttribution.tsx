/**
 * Google attribution, required on every surface that shows a Google-derived drive or position.
 *
 * NOT A DESIGN CHOICE. ADR-0014 takes on Google Maps Platform as a paid dependency, and the
 * Maps terms require attribution wherever their content is displayed — the numbers beside a
 * Request are computed from coordinates Google gave us, so this rides with them. A surface that
 * shows a drive time without this is a licence breach, not an untidy screen.
 *
 * THE TEXT FORM, NOT THE LOGO. Google permits either a logo between 16 and 19dp with defined
 * clear space and no modification, or the text form. The logo would mean embedding an official
 * asset and honouring its clear-space rules inside a table row; the text form is the same
 * permission with far less that can silently go out of spec. Google's specification also names
 * a typeface and weight for it, which this inherits from the surrounding UI rather than
 * hard-coding — flagged here because a reviewer checking strict compliance should look at that
 * clause rather than assume it was considered and satisfied.
 *
 * BOTH THEMES. The requirement is a minimum contrast against whatever it sits on, so the colour
 * is a theme token rather than a fixed grey — a value that passes in light and vanishes in dark
 * is a failure of the same rule, and this component exists partly so that judgement is made
 * once instead of at every call site.
 */
export function GoogleAttribution({ className }: { className?: string }) {
  return (
    <span className={`text-[11px] leading-none text-text-muted ${className ?? ''}`}>Powered by Google</span>
  );
}

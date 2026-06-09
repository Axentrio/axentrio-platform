// Type declaration for CSS Module imports (used by the Expo web template,
// e.g. animated-icon.module.css). Keeps `tsc --noEmit` green.
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

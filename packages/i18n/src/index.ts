// @axentrio/i18n — shared translation resources (mirrors the portal i18n JSON).
// Skeleton: only English is seeded; full locale sync happens as screens land.
import en from './en.json';

export const resources = { en } as const;
export type Locale = keyof typeof resources;

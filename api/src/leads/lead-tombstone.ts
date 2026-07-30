/**
 * Erasure tombstone vocabulary — deliberately its own dependency-free module.
 *
 * Both the capture path and the erasure path need it: erasure WRITES tombstones,
 * capture must REFUSE to mint a key inside the reserved namespace. Putting it in
 * either service would make them import each other, and a static import cycle in
 * this codebase has previously broken unrelated unit suites through vi.mock hoisting
 * and module load order. No imports here, so there is no edge to create.
 */

/**
 * Reserved prefix for an erased lead's `external_user_id` / `dedupe_key`.
 *
 * `computeDedupeKey` only ever emits `<channel>:…`, `email:…` or `phone:…`, so this
 * namespace is unreachable by normal capture and cannot collide.
 */
export const ERASED_PREFIX = 'erased:';

/** Is this dedupe key / external id an erasure tombstone? */
export function isErasedDedupeKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && key.startsWith(ERASED_PREFIX);
}

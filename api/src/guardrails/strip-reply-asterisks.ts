/**
 * Strip markdown / WhatsApp emphasis asterisks from an AI reply.
 *
 * The model wraps names and prices in `*...*` even when the prompt forbids it.
 * WhatsApp then shows the stars. This is the last-chance cleanup on the way out.
 *
 * Owner-authored fallbacks do not go through this helper.
 */
export function stripReplyAsterisks(text: string): string {
  if (!text) return text;
  // Unwrap **bold** first so a markdown pair does not leave stray stars.
  let out = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*([^*]+)\*/g, '$1');
  return out.replace(/\*/g, '');
}

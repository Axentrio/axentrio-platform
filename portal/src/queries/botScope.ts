/**
 * Which Agent a settings query is about.
 *
 * The scheduler and calendar endpoints act on a NAMED Agent, defaulting to the tenant's own
 * anchor when none is given (#86). Two things follow for the client, and getting either wrong
 * reintroduces the bug the ticket exists to fix:
 *
 * 1. **The URL must carry the id**, or the server silently answers for the anchor. That is how
 *    a Disconnect pressed under Agent B's name disconnects Agent A.
 * 2. **The CACHE KEY must carry it too.** Scoping the request without the key is worse than
 *    doing neither: the first Agent fetched populates a shared key and every other Agent reads
 *    it, so the screen shows one Agent's settings under another's name and an invalidation
 *    after a write refreshes the wrong one.
 *
 * `undefined` is a real value here — it means "the tenant's default", which is what keeps a
 * single-Agent tenant sending exactly the requests it always sent.
 */

/**
 * IDENTIFIERS SAY `botId`, PROSE SAYS AGENT. `docs/agents/domain.md` splits these deliberately:
 * prose follows the glossary, code identifiers follow the code — and the column, the entity and
 * the whole existing API surface are `bot_id`/`botId`. A glossary-named identifier layer over a
 * code-named wire would be a private convention invented in one directory, which that document
 * says needs an ADR rather than a preference.
 */

/** The cache-key segment for an Agent. Stable for the default so keys do not churn. */
export function botSegment(botId?: string): string {
  return botId ?? 'default-agent';
}

/** The same URL, addressed at an Agent. Unchanged when none is named. */
export function withBot(url: string, botId?: string): string {
  if (!botId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}botId=${encodeURIComponent(botId)}`;
}

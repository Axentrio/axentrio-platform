/**
 * What grouping is allowed to spend (#81).
 *
 * NOT ABOUT MONEY, and that is the point worth stating first. Grouping spends nothing: it reads
 * this conversation's drive cache and goes neutral on a miss (`cacheOnly` in `routes.service`).
 * That is structural rather than a ceiling, because a ceiling is not enough - grouping and the
 * feasibility gate draw on ONE monthly element counter, so ANY spend, however small a fraction it
 * is capped to, can bring a tenant to an exhaustion they would not otherwise have reached. An
 * exhausted gate turns confirmable slots into Requests, and ADR-0017 forbids grouping from
 * causing that. A preference that can remove a bookable time is not a preference.
 *
 * What is left to bound is the PASS: how many legs it reads and how long it takes. Both are about
 * the customer waiting behind a live availability call, not about the bill.
 */
/** How long a whole scoring pass may take before it stops and leaves the rest neutral. */
export const GROUPING_DEADLINE_MS = 2_000;

/**
 * The most legs one scoring pass may measure.
 *
 * Three per candidate at worst, so this is roughly eight fully-scored slots. A cap on the PASS as
 * well as on the month, because a single conversation must not be able to spend a meaningful
 * fraction of a tenant's budget on preferences.
 */
export const GROUPING_LEG_BUDGET = 24;

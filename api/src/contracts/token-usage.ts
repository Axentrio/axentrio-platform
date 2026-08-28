/**
 * Wire contract: GET /api/v1/billing/token-usage
 *
 * Pure types only — no imports, no runtime code.
 */

export interface TokenPackDto {
  id: 'tokens_5m' | 'tokens_15m';
  tokens: number;
  priceEur: number;
  /** false when the Stripe price ID env var is unset */
  available: boolean;
}

export interface TokenUsageResponse {
  unlimited: boolean;
  allowanceTokens: number;
  topUpTokens: number;
  usedTokens: number;
  /** Rounded integer of used / (allowance + topUp). */
  percentUsed: number;
  warnThreshold: number;
  hardStopThreshold: number;
  periodStart: string;
  periodEnd: string;
  packs: TokenPackDto[];
}

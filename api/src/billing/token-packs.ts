import { config } from '../config/environment';

export type TokenPackId = 'tokens_5m' | 'tokens_15m';

export interface TokenPack {
  id: TokenPackId;
  tokens: number;
  priceEur: number;
}

export const TOKEN_PACKS: Record<TokenPackId, TokenPack> = {
  tokens_5m: { id: 'tokens_5m', tokens: 5_000_000, priceEur: 19 },
  tokens_15m: { id: 'tokens_15m', tokens: 15_000_000, priceEur: 49 },
};

export function tokenPackPriceId(packId: TokenPackId): string | null {
  switch (packId) {
    case 'tokens_5m':
      return config.billing.stripe.priceTokens5m || null;
    case 'tokens_15m':
      return config.billing.stripe.priceTokens15m || null;
  }
}

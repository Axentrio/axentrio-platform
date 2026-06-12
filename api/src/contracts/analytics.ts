/**
 * Wire contract: GET /api/v1/analytics/outcomes (+ /timeseries) — shared
 * between api (provider) and portal (consumer, type-only imports). Pure
 * types; see contracts/entitlements.ts for the directory rules.
 */

export interface OutcomeBucket {
  total: number;
  byChannel?: Record<string, number>;
  bySource?: Record<string, number>;
}

export interface OutcomeAggregates {
  conversations: OutcomeBucket;
  bookings: OutcomeBucket;
  leads: OutcomeBucket;
  /** null when the tenant has no scheduler business hours to classify against. */
  afterHours: { count: number; classifiable: number } | null;
}

export interface DateRangeDto {
  from: string;
  to: string;
}

export interface OutcomesResponse {
  range: DateRangeDto;
  previousRange: DateRangeDto;
  current: OutcomeAggregates;
  previous: OutcomeAggregates;
}

export interface OutcomeSeriesPoint {
  date: string;
  conversations: number;
  bookings: number;
  leads: number;
}

export interface OutcomesTimeseriesResponse {
  timeseries: OutcomeSeriesPoint[];
}

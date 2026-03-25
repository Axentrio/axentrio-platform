/**
 * Metrics Service — stub implementation
 * Tracks request counts and latency for n8n webhook processing.
 * Replace with a real metrics library (prom-client) when needed.
 */

export class MetricsService {
  private static instance: MetricsService;

  static getInstance(): MetricsService {
    if (!MetricsService.instance) {
      MetricsService.instance = new MetricsService();
    }
    return MetricsService.instance;
  }

  incrementCounter(_name: string, _labels?: Record<string, string>): void {
    // Stub: no-op
  }

  recordLatency(_name: string, _durationMs: number, _labels?: Record<string, string>): void {
    // Stub: no-op
  }

  recordHistogram(_name: string, _value: number, _labels?: Record<string, string>): void {
    // Stub: no-op
  }

  getMetrics(): Record<string, unknown> {
    return {};
  }
}

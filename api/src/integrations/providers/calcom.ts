import axios from 'axios';
import { encrypt, decrypt } from '../../utils/encryption';
import { config } from '../../config/environment';
import { ApiError, BadRequestError, RateLimitError } from '../../middleware/error-handler';
import { ERROR_CODES } from '../../middleware/error-codes';
import { IntegrationProvider, IntegrationConfig } from '../types';
import { readIntegrationConfig, writeIntegrationConfig } from '../registry';

const CALCOM_API = 'https://api.cal.com/v2/event-types';
const CALCOM_API_VERSION = '2024-06-14';

export interface CalcomEventType {
  id: number;
  title: string;
  length: number;
  slug: string;
}

interface CalcomPatch {
  apiKey?: string | null;
  eventTypeId?: number;
  collectFields?: string[];
  language?: string;
}

/**
 * Cal.com integration — the first IntegrationProvider. Owns all Cal.com API
 * calls + the persisted config shape. Config stays under
 * Bot.settings.integrations.calcom so booking/egress readers are unaffected.
 */
class CalcomIntegrationProvider implements IntegrationProvider {
  readonly kind = 'calcom';
  readonly feature = 'calendarIntegrations' as const;
  readonly errorCode = 'plan_limit_calendar_integrations';

  redact(config: IntegrationConfig): Record<string, unknown> {
    const { apiKey, ...rest } = config as { apiKey?: string };
    return { ...rest, hasApiKey: !!apiKey };
  }

  applyUpdate(existing: IntegrationConfig | null, patch: unknown): IntegrationConfig {
    const p = patch as CalcomPatch;
    const next: Record<string, unknown> = { ...(existing ?? {}) };

    if (p.apiKey !== undefined) next.apiKey = p.apiKey ? encrypt(p.apiKey) : null;
    if (p.eventTypeId) next.eventTypeId = p.eventTypeId;
    if (p.collectFields) next.collectFields = p.collectFields;
    if (p.language) next.language = p.language;

    return next;
  }

  /**
   * No-op since issue #3: selecting a Cal.com event type used to auto-point
   * tenant.webhookUrl at the default n8n webhook, but that workflow is dead and
   * bookings now run through the internal engine / platform agent. A genuinely
   * custom tenant.webhookUrl is left untouched.
   */
  async afterUpdate(_tenantId: string, _integrationConfig: IntegrationConfig | null): Promise<void> {
    // intentionally empty
  }

  /** Validate an API key against Cal.com, persist it, and return event types. */
  async connect(tenantId: string, apiKey: unknown): Promise<CalcomEventType[]> {
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length > 256) {
      throw new BadRequestError('A valid API key is required');
    }

    let raw: any[];
    try {
      raw = await this.callEventTypesApi(apiKey);
    } catch (err: any) {
      if (err?.response?.status === 401) {
        throw new BadRequestError('Invalid or expired API key');
      }
      if (err?.response?.status === 429) {
        throw new RateLimitError('Cal.com rate limit exceeded. Please try again later.');
      }
      throw new ApiError('Could not reach Cal.com. Please try again later.', 502, ERROR_CODES.UPSTREAM_FAILED);
    }

    if (raw.length === 0) {
      throw new BadRequestError('No event types found. Create one in Cal.com first.');
    }

    const existing = (await readIntegrationConfig(tenantId, this.kind)) ?? {};
    const webhookUrl = (existing as { webhookUrl?: string }).webhookUrl || config.n8n.defaultWebhookUrl || undefined;
    const next: Record<string, unknown> = { ...existing, apiKey: encrypt(apiKey), webhookUrl };
    delete next.eventTypeId; // force re-pick on reconnect
    await writeIntegrationConfig(tenantId, this.kind, next);

    return this.mapEventTypes(raw);
  }

  /** Fetch event types using the stored (encrypted) API key. */
  async listEventTypes(tenantId: string): Promise<CalcomEventType[]> {
    const stored = await readIntegrationConfig(tenantId, this.kind);
    const apiKey = (stored as { apiKey?: string } | null)?.apiKey;
    if (!apiKey) {
      throw new BadRequestError('Cal.com not connected');
    }

    try {
      const raw = await this.callEventTypesApi(decrypt(apiKey));
      return this.mapEventTypes(raw);
    } catch (err: any) {
      if (err?.response?.status === 401) {
        throw new BadRequestError('Cal.com API key is invalid or expired');
      }
      throw new ApiError('Could not reach Cal.com', 502, ERROR_CODES.UPSTREAM_FAILED);
    }
  }

  private async callEventTypesApi(apiKey: string): Promise<any[]> {
    const response = await axios.get(CALCOM_API, {
      headers: { Authorization: `Bearer ${apiKey}`, 'cal-api-version': CALCOM_API_VERSION },
      timeout: 10000,
    });
    const responseData = response.data?.data;
    if (Array.isArray(responseData)) return responseData;
    const groups: any[] = responseData?.eventTypeGroups ?? [];
    return groups.flatMap((g: any) => g.eventTypes ?? []);
  }

  private mapEventTypes(raw: any[]): CalcomEventType[] {
    return raw.map((et: any) => ({
      id: et.id,
      title: et.title || et.slug,
      length: et.lengthInMinutes ?? et.length ?? 0,
      slug: et.slug,
    }));
  }
}

export const calcomProvider = new CalcomIntegrationProvider();

import { config } from '../../config/environment';
import { logger } from '../../utils/logger';
import type { BillitOrderPayload, PeppolParticipant } from './types';

export class BillitClientError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(code);
    this.name = 'BillitClientError';
  }
}

export interface BillitCreatedOrder {
  orderId: string;
  orderNumber: string;
}

export interface BillitClient {
  isConfigured(): boolean;
  consumeNextNumber(kind: 'invoice' | 'credit_note'): Promise<string>;
  createOrder(order: BillitOrderPayload, idempotencyKey: string): Promise<BillitCreatedOrder>;
  sendOrders(orderIds: string[], transportType: 'Peppol'): Promise<void>;
  getOrder(orderId: string): Promise<{ orderId: string; orderNumber: string; isSent: boolean }>;
  lookupPeppol(vatNumber: string): Promise<PeppolParticipant>;
}

let override: BillitClient | null = null;

export function setBillitClient(client: BillitClient | null): void {
  override = client;
}

export function getBillitClient(): BillitClient {
  return override ?? liveBillitClient;
}

function billitConfig(): { apiUrl: string; apiKey: string; partyId: string } {
  return {
    apiUrl: config.billing.billit.apiUrl.replace(/\/$/, ''),
    apiKey: config.billing.billit.apiKey,
    partyId: config.billing.billit.partyId,
  };
}

async function billitFetch(
  method: string,
  path: string,
  opts: { body?: unknown; idempotencyKey?: string; strictPeppol?: boolean } = {},
): Promise<unknown> {
  const { apiUrl, apiKey, partyId } = billitConfig();
  if (!apiKey || !partyId) {
    throw new BillitClientError('billit_not_configured');
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    PartyID: partyId,
    ApiKey: apiKey,
  };
  if (opts.idempotencyKey) {
    headers['Idempotency-Key'] = opts.idempotencyKey;
    headers['Idempotent-Key'] = opts.idempotencyKey;
  }
  if (opts.strictPeppol) {
    headers.StrictTransportType = 'true';
  }
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (err) {
    throw new BillitClientError(
      'billit_network_error',
      undefined,
      err instanceof Error ? err.message : String(err),
    );
  }
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    logger.warn('Billit request failed', {
      method,
      path,
      status: res.status,
    });
    throw new BillitClientError('billit_http_error', res.status, parsed);
  }
  return parsed;
}

function readSequence(body: unknown): string {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (typeof body === 'number') return String(body);
  if (body && typeof body === 'object') {
    const row = body as Record<string, unknown>;
    for (const key of ['Sequence', 'Number', 'OrderNumber', 'Value', 'sequence', 'NextSequence']) {
      const value = row[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
  }
  throw new BillitClientError('billit_sequence_unreadable', undefined, body);
}

function readCreatedOrder(body: unknown, fallbackNumber: string): BillitCreatedOrder {
  if (typeof body === 'number') {
    return { orderId: String(body), orderNumber: fallbackNumber };
  }
  if (typeof body === 'string' && /^\d+$/.test(body.trim())) {
    return { orderId: body.trim(), orderNumber: fallbackNumber };
  }
  if (body && typeof body === 'object') {
    const row = body as Record<string, unknown>;
    const orderId = row.OrderID ?? row.orderID ?? row.Id ?? row.id;
    const orderNumber = row.OrderNumber ?? row.orderNumber ?? fallbackNumber;
    if (orderId != null) {
      return { orderId: String(orderId), orderNumber: String(orderNumber) };
    }
  }
  throw new BillitClientError('billit_create_unreadable', undefined, body);
}

export const liveBillitClient: BillitClient = {
  isConfigured() {
    const { apiKey, partyId } = billitConfig();
    return Boolean(apiKey && partyId);
  },

  async consumeNextNumber(kind) {
    const body = await billitFetch('POST', '/v1/account/sequences', {
      body: {
        SequenceType: kind === 'credit_note' ? 'Income-CreditNote' : 'Income-Invoice',
        Consume: true,
      },
    });
    return readSequence(body);
  },

  async createOrder(order, idempotencyKey) {
    try {
      const body = await billitFetch('POST', '/v1/orders', {
        body: order,
        idempotencyKey,
      });
      return readCreatedOrder(body, order.OrderNumber);
    } catch (err) {
      if (err instanceof BillitClientError && err.status === 409) {
        throw new BillitClientError('billit_idempotent_replay', 409, err.body);
      }
      throw err;
    }
  },

  async sendOrders(orderIds, transportType) {
    await billitFetch('POST', '/v1/orders/commands/send', {
      body: {
        Transporttype: transportType,
        OrderIDs: orderIds.map((id) => Number(id)).filter((n) => Number.isFinite(n)),
      },
      strictPeppol: transportType === 'Peppol',
    });
  },

  async getOrder(orderId) {
    const body = await billitFetch('GET', `/v1/orders/${orderId}`);
    if (!body || typeof body !== 'object') {
      throw new BillitClientError('billit_get_unreadable', undefined, body);
    }
    const row = body as Record<string, unknown>;
    return {
      orderId: String(row.OrderID ?? orderId),
      orderNumber: String(row.OrderNumber ?? ''),
      isSent: row.IsSent === true,
    };
  },

  async lookupPeppol(vatNumber) {
    const body = await billitFetch(
      'GET',
      `/v1/peppol/participantInformation/${encodeURIComponent(vatNumber)}`,
    );
    if (!body || typeof body !== 'object') {
      return { registered: false, documentTypes: [] };
    }
    const row = body as { Registered?: boolean; DocumentTypes?: string[] };
    return {
      registered: row.Registered === true,
      documentTypes: Array.isArray(row.DocumentTypes) ? row.DocumentTypes : [],
    };
  },
};

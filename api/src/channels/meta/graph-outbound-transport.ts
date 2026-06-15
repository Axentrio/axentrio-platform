import axios, { AxiosRequestConfig } from 'axios';
import { ChannelConnection } from '../../database/entities/ChannelConnection';
import { OutboundTransport, OutboundChannelMessage, DeliveryResult, ChannelCapabilities, TypingContext } from '../types';
import { parseAxiosError } from '../../utils/axios-error';
import { logger } from '../../utils/logger';

export interface GraphSendRequest {
  url: string;
  config: AxiosRequestConfig;
}

/**
 * Shared outbound-transport skeleton for Graph-family channels (Messenger,
 * Instagram, WhatsApp). They differ only in how the request is authenticated
 * and where the message id lives in the response — everything else (the
 * POST + uniform error/retry handling) is identical, so it lives here.
 *
 * Subclasses implement:
 *  - getCapabilities / sendTypingIndicator (per-channel behavior)
 *  - buildSendBody       — the platform message payload
 *  - buildRequest        — endpoint + auth (or an error if creds are missing)
 *  - extractMessageId    — pull the platform message id from a 2xx response
 */
export abstract class GraphOutboundTransport implements OutboundTransport {
  protected abstract readonly logTag: string;

  abstract getCapabilities(): ChannelCapabilities;
  abstract sendTypingIndicator(
    externalThreadId: string,
    connection: ChannelConnection,
    context?: TypingContext,
  ): Promise<void>;

  protected abstract buildSendBody(message: OutboundChannelMessage, recipientId: string): Record<string, unknown>;
  protected abstract buildRequest(connection: ChannelConnection): GraphSendRequest | { error: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected abstract extractMessageId(data: any): string | undefined;

  async send(
    message: OutboundChannelMessage,
    externalThreadId: string,
    connection: ChannelConnection,
  ): Promise<DeliveryResult> {
    const request = this.buildRequest(connection);
    if ('error' in request) {
      return { success: false, error: request.error, retryable: false };
    }

    try {
      const body = this.buildSendBody(message, externalThreadId);
      const response = await axios.post(request.url, body, request.config);
      return { success: true, platformMessageId: this.extractMessageId(response.data) };
    } catch (error) {
      const { message: errMsg, retryable } = parseAxiosError(error);
      logger.error(`${this.logTag} Send failed to ${externalThreadId}:`, errMsg);
      return { success: false, error: errMsg, retryable };
    }
  }
}

import { Resend } from 'resend';
import { logger } from '../utils/logger';

interface EmailAttachment {
  filename: string;
  /** Base64-encoded content. */
  content: string;
  contentType?: string;
}

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
  attachments?: EmailAttachment[];
  /** Extra SMTP headers (e.g. List-Unsubscribe for one-click opt-out). */
  headers?: Record<string, string>;
  /**
   * Resend idempotency key — dedupes a retried send within Resend's window so
   * a reconciler that re-claims after a crash can't double-deliver.
   */
  idempotencyKey?: string;
}

interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class EmailService {
  private readonly resend: Resend | null;
  private readonly defaultFrom: string;

  constructor(apiKey: string | undefined, defaultFrom: string) {
    this.defaultFrom = defaultFrom;
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  async send(options: SendEmailOptions): Promise<SendEmailResult> {
    const { to, subject, body, from, replyTo, attachments, headers, idempotencyKey } = options;

    if (!this.resend) {
      logger.warn('[EmailService] send called but no API key configured');
      return { success: false, error: 'not configured' };
    }

    const fromAddress = from ?? this.defaultFrom;
    const recipients = Array.isArray(to) ? to : [to];

    logger.info('[EmailService] sending email', { to: recipients, subject, from: fromAddress });

    const { data, error } = await this.resend.emails.send(
      {
        from: fromAddress,
        to: recipients,
        subject,
        html: body,
        ...(replyTo ? { replyTo } : {}),
        ...(headers ? { headers } : {}),
        ...(attachments && attachments.length
          ? {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                ...(a.contentType ? { contentType: a.contentType } : {}),
              })),
            }
          : {}),
      },
      ...(idempotencyKey ? [{ idempotencyKey }] : []),
    );

    if (error) {
      logger.error('[EmailService] resend error', { error });
      return { success: false, error: error.message };
    }

    logger.info('[EmailService] email sent', { messageId: data?.id });
    return { success: true, messageId: data?.id };
  }
}

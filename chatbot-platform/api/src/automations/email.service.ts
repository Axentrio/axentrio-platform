import { Resend } from 'resend';
import { logger } from '../utils/logger';

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
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
    const { to, subject, body, from, replyTo } = options;

    if (!this.resend) {
      logger.warn('[EmailService] send called but no API key configured');
      return { success: false, error: 'not configured' };
    }

    const fromAddress = from ?? this.defaultFrom;
    const recipients = Array.isArray(to) ? to : [to];

    logger.info('[EmailService] sending email', { to: recipients, subject, from: fromAddress });

    const { data, error } = await this.resend.emails.send({
      from: fromAddress,
      to: recipients,
      subject,
      html: body,
      ...(replyTo ? { replyTo } : {}),
    });

    if (error) {
      logger.error('[EmailService] resend error', { error });
      return { success: false, error: error.message };
    }

    logger.info('[EmailService] email sent', { messageId: data?.id });
    return { success: true, messageId: data?.id };
  }
}

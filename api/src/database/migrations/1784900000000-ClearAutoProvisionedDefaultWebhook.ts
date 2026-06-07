import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clear the auto-provisioned default n8n webhook from tenants (issue #3).
 *
 * Older flows auto-pointed `tenants.webhook_url` at the default n8n webhook
 * (`config.n8n.defaultWebhookUrl`) whenever AI was enabled or a Cal.com event
 * type was selected. That workflow is inactive, and AI bots are now answered by
 * the platform agent — runtime already ignores the default via
 * `isCustomWebhookUrl()`. This nulls the stale value so the stored data reflects
 * reality and nothing keys off a dead URL.
 *
 * Only rows EQUAL to the configured default are touched — genuinely custom
 * tenant webhooks are left intact. No-op if the default isn't configured.
 * Irreversible (we can't tell which rows were auto-provisioned), so `down` is a
 * no-op.
 */
export class ClearAutoProvisionedDefaultWebhook1784900000000 implements MigrationInterface {
  name = 'ClearAutoProvisionedDefaultWebhook1784900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const defaultUrl =
      process.env.N8N_DEFAULT_WEBHOOK_URL ||
      process.env.WEBHOOK_URL ||
      process.env.N8N_WEBHOOK_URL;

    if (!defaultUrl) return; // nothing to match against

    await queryRunner.query(
      `UPDATE tenants SET webhook_url = NULL WHERE webhook_url = $1`,
      [defaultUrl],
    );
  }

  public async down(): Promise<void> {
    // Irreversible: the original auto-provisioned URL cannot be distinguished
    // from a deliberately-unset one. No-op.
  }
}

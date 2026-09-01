import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SV — a new Service starts on `request` for both customer change modes.
 *
 * The Agent must never move or cancel a confirmed appointment on its own until
 * the owner opts in, so "Request approval" is the value an owner gets when they
 * add a Service and never open the policy fields.
 *
 * Column default only. Existing rows KEEP their stored mode: the column cannot
 * tell an owner who chose `auto` from an owner who inherited it, and silently
 * disabling auto-reschedule on live appointments is not reversible.
 */
export class DefaultCustomerChangeToRequest1794100000000 implements MigrationInterface {
  name = 'DefaultCustomerChangeToRequest1794100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ALTER COLUMN "reschedule_mode" SET DEFAULT 'request',
        ALTER COLUMN "cancel_mode" SET DEFAULT 'request'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chatbot_service_types"
        ALTER COLUMN "reschedule_mode" SET DEFAULT 'auto',
        ALTER COLUMN "cancel_mode" SET DEFAULT 'auto'
    `);
  }
}

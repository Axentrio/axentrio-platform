import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBookingLogs1780000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE booking_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        session_id UUID NOT NULL,
        idempotency_key VARCHAR(255),
        cal_booking_id VARCHAR(255),
        event_type VARCHAR(50) NOT NULL,
        attendee_name VARCHAR(255),
        attendee_email VARCHAR(255),
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(tenant_id, idempotency_key)
      );

      CREATE INDEX idx_booking_logs_tenant_created ON booking_logs(tenant_id, created_at);
      CREATE INDEX idx_booking_logs_tenant_email ON booking_logs(tenant_id, attendee_email);
      CREATE INDEX idx_booking_logs_cal_booking ON booking_logs(cal_booking_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS booking_logs;`);
  }
}

import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index the external customer-thread lookup (#132).
 *
 * The /thread and possible-duplicates queries match external sessions by
 * `(tenant_id, "channelConnectionId", visitor_id, metadata->'customData'->>'externalThreadId')`.
 * The last term is a jsonb expression no existing index covered, so the lookup
 * fell back to the `(tenant_id, visitor_id)` index plus a per-row jsonb scan.
 * A partial expression index over the exact predicate serves it directly, and
 * stays small by covering only external sessions that actually carry a thread id.
 *
 * Additive and reversible: `up` creates, `down` drops. Migration-only (no entity
 * `@Index`) because TypeORM's schema sync cannot model a jsonb expression index,
 * and this is a performance index rather than a correctness constraint.
 */
export class AddExternalThreadIndex1791900000000 implements MigrationInterface {
  name = 'AddExternalThreadIndex1791900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_chat_sessions_external_thread"
        ON "chat_sessions" (
          "tenant_id",
          "channelConnectionId",
          "visitor_id",
          (("metadata" -> 'customData' ->> 'externalThreadId'))
        )
        WHERE "source" <> 'widget'
          AND ("metadata" -> 'customData' ->> 'externalThreadId') IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "ix_chat_sessions_external_thread"`);
  }
}

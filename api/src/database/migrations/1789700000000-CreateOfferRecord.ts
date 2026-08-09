import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #80 (LP3) - the pre-steering baseline.
 *
 * Three append-only tables. Nothing customer-visible, no Google elements, no ranking. LP5 has to
 * prove that reordering slots helps, which needs to know how often a customer took the FIRST slot
 * offered before anything reordered them - and that cannot be reconstructed afterwards. Every
 * booking taken before this exists is one nothing can be compared against.
 *
 * Contract: `docs/specs/lp3-offer-record.md`, approved after five review rounds.
 */
export class CreateOfferRecord1789700000000 implements MigrationInterface {
  name = 'CreateOfferRecord1789700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Every check_availability call, surfaced or not. A separate unit from the offer: calls the
    // model discards never become offers, and several calls can precede one response, so an
    // offer-level denominator would be wrong in both directions.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_availability_calls" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "bot_id" uuid NOT NULL,
        -- No FK on session_id anywhere in these tables: a measurement row must not keep a
        -- customer's conversation alive past its own retention.
        "session_id" uuid NOT NULL,
        "service_id" uuid,
        "requested_start_date" date,
        "requested_end_date" date,
        "requested_range_raw" varchar(128),
        "range_valid" boolean NOT NULL DEFAULT true,
        "slot_count" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_availability_calls_created" ON "chatbot_availability_calls" ("created_at")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_availability_calls_session" ON "chatbot_availability_calls" ("session_id")`
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_booking_offers" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "tenant_id" uuid NOT NULL,
        "bot_id" uuid NOT NULL,
        "session_id" uuid NOT NULL,
        "service_id" uuid,
        "availability_call_id" uuid,
        "location_mode" varchar(32),
        "channel" varchar(32),
        -- Ordered, and holding BOTH the canonical instant and the rendered label. Storing only
        -- the label makes a Booking unmatchable (the chip text is natural language); storing only
        -- the instant records slots the channel may have truncated away.
        "offered_slots" jsonb NOT NULL,
        "offered_count" integer NOT NULL,
        "delivery_basis" varchar(32) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ck_booking_offers_count"
          CHECK ("offered_count" = jsonb_array_length("offered_slots"))
      )
    `);
    // The attribution lookup, which is the only hot read: the latest offer for this session and
    // service before a given instant.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_booking_offers_attribution"
         ON "chatbot_booking_offers" ("session_id", "service_id", "created_at")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_booking_offers_created" ON "chatbot_booking_offers" ("created_at")`
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "chatbot_offer_selections" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "offer_id" uuid NOT NULL REFERENCES "chatbot_booking_offers"("id") ON DELETE CASCADE,
        -- UNIQUE on the entity, not on the pair. One Booking gets exactly one attribution; a
        -- (offer, entity) rule would still let one Booking be attributed to several offers and
        -- counted twice in every denominator.
        "selection_entity_id" uuid NOT NULL UNIQUE,
        "selection_type" varchar(16) NOT NULL,
        "selected_ordinal" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "ix_offer_selections_offer" ON "chatbot_offer_selections" ("offer_id")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Selections first: they reference offers.
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_offer_selections"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_booking_offers"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chatbot_availability_calls"`);
  }
}

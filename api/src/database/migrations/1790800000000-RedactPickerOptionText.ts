import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Redact the Google Places suggestion text from address-picker replies already written.
 *
 * ADR-0014 is default-deny on caching Google Maps Content. The Meta address picker stored every
 * offered suggestion string in `messages.metadata.affordance.options[].text`, including the ones
 * the customer never chose, in an unencrypted JSONB column with no expiry. The going-forward write
 * path (`storedAffordance` in `replyMetadata`) now persists only the `{id, placeId}` evidence; this
 * removes the string from the rows that predate that change.
 *
 * `offeredPlaceId` reads only `option->>'placeId'` and `option->>'id'`, so dropping `text` leaves
 * every in-flight and historical picker still tappable.
 *
 * Scope: this scrubs `messages.metadata` only. The same suggestion text was also written into
 * `agent_traces.trace` (a two-level-nested jsonb array on the highest-volume audit table, which has
 * no retention). The going-forward leak there is closed in code (`agent.service.ts`), and the
 * historical rows are scrubbed by a separate verified script rather than a boot-time nested-jsonb
 * rewrite on the busiest table. See #98 and its follow-ups.
 */
export class RedactPickerOptionText1790800000000 implements MigrationInterface {
  name = 'RedactPickerOptionText1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // `messages.metadata` has no index, so a metadata-only predicate is a one-time Seq Scan. It
    // runs once (TypeORM records the migration) and takes a row lock only on the matched picker
    // rows, a small subset. The EXISTS guard makes it idempotent: a re-run matches no row whose
    // options already carry no `text`, so `down()` is not needed to make a repeat run safe.
    await queryRunner.query(`
      UPDATE messages
         SET metadata = jsonb_set(
               metadata,
               '{affordance,options}',
               (
                 SELECT COALESCE(jsonb_agg(elem - 'text'), '[]'::jsonb)
                   FROM jsonb_array_elements(metadata #> '{affordance,options}') AS elem
               )
             )
       WHERE metadata #>> '{affordance,kind}' = 'address_picker'
         AND jsonb_typeof(metadata #> '{affordance,options}') = 'array'
         AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(metadata #> '{affordance,options}') AS e
                WHERE e ? 'text'
             )
    `);
  }

  public async down(): Promise<void> {
    // Irreversible by design: the migration deleted Google Maps Content that ADR-0014 gives us no
    // permission to hold. Nothing can be restored, and re-creating the strings would re-introduce
    // the exact licence breach this migration closed.
    throw new Error(
      'RedactPickerOptionText1790800000000 is irreversible: deleted Google Content cannot be restored',
    );
  }
}

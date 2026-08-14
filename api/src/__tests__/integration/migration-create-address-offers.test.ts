import { describe, expect, it } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { CreateAddressOffers1790900000000 } from '../../database/migrations/1790900000000-CreateAddressOffers';

/**
 * Boot-safety guard for CreateAddressOffers (#97 D3). The integration schema is built by
 * `synchronize()`, not by migrations, so this is the only place the migration SQL runs against a
 * real Postgres. up() runs twice to prove the `IF NOT EXISTS` guards make it idempotent on boot.
 * down() (a plain DROP) is not exercised here, because it would remove the table the rest of this
 * worker's tests share.
 */
describe('CreateAddressOffers migration', () => {
  it('up() creates the table and is idempotent on a re-run', async () => {
    const m = new CreateAddressOffers1790900000000();
    const qr = AppDataSource.createQueryRunner();
    try {
      await qr.connect();
      await m.up(qr);
      await m.up(qr);
      const [row] = await qr.query(
        `SELECT to_regclass('public.chatbot_address_offers') IS NOT NULL AS present`,
      );
      expect(row.present).toBe(true);
    } finally {
      await qr.release();
    }
  });
});

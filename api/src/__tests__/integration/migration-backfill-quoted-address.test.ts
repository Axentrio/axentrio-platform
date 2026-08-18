import { describe, expect, it } from 'vitest';
import { resolveQuotedAddress } from '../../account/quoted-address';
import { AppDataSource } from '../../database/data-source';
import { Bot } from '../../database/entities/Bot';
import { BackfillQuotedAddress1792700000000 } from '../../database/migrations/1792700000000-BackfillQuotedAddress';
import { createTestAnchorBot, createTestTenant } from '../helpers/factories';

describe('BackfillQuotedAddress migration', () => {
  it('restores legacy disabled rows to the account-address default', async () => {
    const tenant = await createTestTenant({
      invoiceAddress: {
        street: 'Account Street',
        streetNumber: '10',
        postalCode: '75001',
        city: 'Paris',
        country: 'FR',
      },
    });
    const bot = await createTestAnchorBot(tenant, {
      settings: {
        quotedAddress: {
          enabled: false,
          street: 'Ignored Legacy Street',
          streetNumber: '99',
          postalCode: '1000',
          city: 'Brussels',
          country: 'BE',
        },
      } as Bot['settings'],
    });

    const queryRunner = AppDataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      const migration = new BackfillQuotedAddress1792700000000();
      await migration.up(queryRunner);
      await migration.up(queryRunner);
    } finally {
      await queryRunner.release();
    }

    const reloaded = await AppDataSource.getRepository(Bot).findOneByOrFail({ id: bot.id });
    expect(reloaded.settings.quotedAddress).toBeUndefined();
    expect(
      resolveQuotedAddress({
        botAddressEnabled: reloaded.settings.quotedAddress?.enabled !== false,
        botAddress: reloaded.settings.quotedAddress ?? null,
        accountAddress: tenant.invoiceAddress,
      }),
    ).toBe('Account Street 10, 75001 Paris, FR');
  });
});

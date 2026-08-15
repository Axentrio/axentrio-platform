/**
 * Correctness and boot-idempotence guard for RemoveDeadBusinessHoursTimezone (TZ PR1c).
 *
 * The migration removes only the historical business-hours JSON key. The canonical bot
 * timezone and the availability-rule compatibility column must remain untouched.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { AvailabilityRule } from '../../database/entities/AvailabilityRule';
import { Bot } from '../../database/entities/Bot';
import { RemoveDeadBusinessHoursTimezone1791600000000 } from '../../database/migrations/1791600000000-RemoveDeadBusinessHoursTimezone';
import { createTestAnchorBot, createTestTenant } from '../helpers/factories';

describe('RemoveDeadBusinessHoursTimezone migration', () => {
  let withTimezone: Bot;
  let withoutTimezone: Bot;
  let withoutBusinessHours: Bot;

  beforeEach(async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    withTimezone = await createTestAnchorBot(tenant, {
      settings: {
        businessHours: {
          enabled: true,
          timezone: 'Europe/Brussels',
          schedule: [],
        },
      } as unknown as Bot['settings'],
    });

    const noTimezoneTenant = await createTestTenant({ tier: 'pro' });
    withoutTimezone = await createTestAnchorBot(noTimezoneTenant, {
      settings: {
        businessHours: { enabled: true, schedule: [] },
      } as unknown as Bot['settings'],
    });

    const noBusinessHoursTenant = await createTestTenant({ tier: 'pro' });
    withoutBusinessHours = await createTestAnchorBot(noBusinessHoursTenant, { settings: {} });
  });

  async function settingsOf(botId: string): Promise<Record<string, any>> {
    const [row] = await AppDataSource.query(`SELECT settings FROM chatbot_bots WHERE id = $1`, [botId]);
    return row.settings;
  }

  async function runUp(): Promise<void> {
    const migration = new RemoveDeadBusinessHoursTimezone1791600000000();
    const queryRunner = AppDataSource.createQueryRunner();
    try {
      await queryRunner.connect();
      await migration.up(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  it('scrubs only the dead key, is idempotent, and leaves unrelated rows untouched', async () => {
    const availabilityRule = await AppDataSource.getRepository(AvailabilityRule).save(
      AppDataSource.getRepository(AvailabilityRule).create({
        tenantId: withTimezone.tenantId,
        botId: withTimezone.id,
        timezone: 'Asia/Kuala_Lumpur',
        availabilityMode: 'business_hours',
        weeklyHours: {},
        dateOverrides: [],
        slotGranularityMin: 30,
      }),
    );

    await runUp();

    const afterFirstRun = await settingsOf(withTimezone.id);
    expect(afterFirstRun.businessHours).not.toHaveProperty('timezone');
    expect(afterFirstRun.businessHours).toMatchObject({ enabled: true, schedule: [] });

    await runUp();

    const afterSecondRun = await settingsOf(withTimezone.id);
    expect(afterSecondRun).toEqual(afterFirstRun);

    expect(await settingsOf(withoutTimezone.id)).toEqual({
      businessHours: { enabled: true, schedule: [] },
    });
    expect(await settingsOf(withoutBusinessHours.id)).toEqual({});

    const ruleAfterMigration = await AppDataSource.getRepository(AvailabilityRule).findOneOrFail({
      where: { id: availabilityRule.id },
    });
    expect(ruleAfterMigration.timezone).toBe('Asia/Kuala_Lumpur');

    await new RemoveDeadBusinessHoursTimezone1791600000000().down();
  });
});

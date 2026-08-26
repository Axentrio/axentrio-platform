import { describe, expect, it, vi } from 'vitest';

const { info } = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logWhatsAppAccountUpdates } from '../../channels/whatsapp/account-update';

describe('logWhatsAppAccountUpdates', () => {
  it('logs PARTNER_ADDED without throwing', () => {
    logWhatsAppAccountUpdates({
      object: 'whatsapp_business_account',
      entry: [{
        id: 'WABA_1',
        changes: [{
          field: 'account_update',
          value: { event: 'PARTNER_ADDED', waba_info: { waba_id: 'WABA_1', owner_business_id: 'BIZ_1' } },
        }],
      }],
    });
    expect(info).toHaveBeenCalledWith(
      '[whatsapp-es] account_update',
      expect.objectContaining({ wabaId: 'WABA_1', event: 'PARTNER_ADDED' }),
    );
  });
});

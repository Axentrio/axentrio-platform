/**
 * Embedded Signup fires `account_update` on the WhatsApp Business Account
 * object (PARTNER_ADDED, etc.). The messages normalizer ignores those fields
 * because they have no phone_number_id. Log them so we can wire persistence
 * later without dropping the webhook 200.
 */

import { logger } from '../../utils/logger';

interface AccountUpdateEntry {
  id?: string;
  changes?: Array<{
    field?: string;
    value?: { event?: string; waba_info?: { waba_id?: string; owner_business_id?: string } };
  }>;
}

export function logWhatsAppAccountUpdates(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return;
  const entries = (payload as { entry?: AccountUpdateEntry[] }).entry;
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    for (const change of entry.changes || []) {
      if (change.field !== 'account_update') continue;
      logger.info('[whatsapp-es] account_update', {
        wabaId: change.value?.waba_info?.waba_id || entry.id,
        event: change.value?.event,
        ownerBusinessId: change.value?.waba_info?.owner_business_id,
      });
    }
  }
}

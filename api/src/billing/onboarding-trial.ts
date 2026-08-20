import { AppDataSource } from '../database/data-source';
import { returningRows } from '../utils/raw-sql';

/** Atomically expire a locally granted onboarding trial. */
export async function expireOnboardingProTrial(tenantId: string): Promise<boolean> {
  return returningRows<{ id: string }>(await AppDataSource.query(
    `WITH expired AS (
       UPDATE tenant_billing_accounts
          SET status = 'none',
              current_plan_id = 'free',
              trial_end = NULL,
              updated_at = now()
        WHERE tenant_id = $1
          AND is_primary = true
          AND provider = 'manual'
          AND status = 'trialing'
          AND trial_end <= now()
        RETURNING tenant_id
     )
     UPDATE tenants
        SET tier = 'free',
            updated_at = now()
      WHERE id IN (SELECT tenant_id FROM expired)
      RETURNING id`,
    [tenantId],
  )).length > 0;
}

import type { ChatSession } from '../database/entities/ChatSession';
import { getBotConfigForSession } from '../services/bot-config.service';

/** Platform kill switch. Default ON: only the literal string 'false' disables it. */
export function isCustomerMemoryEnabled(): boolean {
  return process.env.CUSTOMER_MEMORY_ENABLED !== 'false';
}

/** Both gates for one bot. Reuses the same bot-config resolver the agent turn uses. */
export async function isMemoryEnabledForSession(session: ChatSession): Promise<boolean> {
  if (!isCustomerMemoryEnabled()) return false;
  try {
    const { settings } = await getBotConfigForSession(session);
    return settings.features?.customerMemoryEnabled !== false;
  } catch {
    return false;
  }
}

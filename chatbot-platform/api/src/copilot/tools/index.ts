/**
 * Build the v1 `CopilotToolRegistry` with the 7 read-only tools.
 *
 * Single source of truth for "what tools does the Copilot have." The
 * registry asserts at registration time that:
 *   - Each tool's `parameters` has no tenant-binding keys (recursive)
 *   - Each tool's args declare no resource-id-shaped keys
 *
 * Adding a tool means amending both `V1_COPILOT_TOOL_NAMES` in
 * `registry.ts` and this build function — `copilot-registry.test.ts`
 * asserts the two stay in sync, so a forgotten name flags loudly.
 */
import { CopilotToolRegistry } from './registry';
import { getTenantSummary } from './getTenantSummary';
import { getBotReadinessStatus } from './getBotReadinessStatus';
import { getIntegrationsStatus } from './getIntegrationsStatus';
import { getEntitlements } from './getEntitlements';
import { getLeadStats } from './getLeadStats';
import { getRecentChatSessionStats } from './getRecentChatSessionStats';
import { getKnownGapTopics } from './getKnownGapTopics';

export function buildV1CopilotToolRegistry(): CopilotToolRegistry {
  const r = new CopilotToolRegistry();
  r.registerTool(getTenantSummary);
  r.registerTool(getBotReadinessStatus);
  r.registerTool(getIntegrationsStatus);
  r.registerTool(getEntitlements);
  r.registerTool(getLeadStats);
  r.registerTool(getRecentChatSessionStats);
  r.registerTool(getKnownGapTopics);
  return r;
}

export {
  getTenantSummary,
  getBotReadinessStatus,
  getIntegrationsStatus,
  getEntitlements,
  getLeadStats,
  getRecentChatSessionStats,
  getKnownGapTopics,
};

/**
 * `CopilotToolRegistry` — separate, narrower hierarchy from the
 * end-user `ToolRegistry` in `agent/tool-registry.ts`. Two reasons
 * for the duplication (chosen over inheritance):
 *
 *   1. The end-user registry accepts mutating tools by design
 *      (capture-lead writes, booking creates, etc). Copilot tools
 *      are read-only. Inheriting would mean re-deriving the
 *      restriction inside every Copilot call site.
 *
 *   2. The end-user registry's tool list is data-driven by the
 *      Tenant's enabled features. Copilot's list is the engineering
 *      whitelist below — same 7 tools for every Pro tenant.
 *
 * Registration-time invariants (enforced HERE, not at execution):
 *
 *   - Schema denylist (recursive case-insensitive) — no
 *     `tenantId`-shaped key anywhere in `parameters`
 *   - No resource-id args (v1)
 *
 * `getCopilotTools()` returns the registered tools in registration
 * order. The unit test `copilot-registry.test.ts` asserts the
 * registered name set equals the v1 plan's 7-tool list exactly —
 * adding or removing a tool is therefore a deliberate spec change,
 * not a silent regression.
 */
import {
  assertSchemaHasNoResourceIds,
  assertSchemaHasNoTenantKeys,
  type CopilotTool,
} from './types';

export const V1_COPILOT_TOOL_NAMES = [
  'getTenantSummary',
  'getBotReadinessStatus',
  'getIntegrationsStatus',
  'getEntitlements',
  'getLeadStats',
  'getRecentChatSessionStats',
  'getKnownGapTopics',
] as const;

export type V1CopilotToolName = (typeof V1_COPILOT_TOOL_NAMES)[number];

export class CopilotToolRegistry {
  private readonly tools = new Map<string, CopilotTool<any, any>>();

  /**
   * Register a Copilot tool. Throws if `name` collides with an
   * already-registered tool, or if the parameter schema fails any
   * invariant.
   */
  registerTool(tool: CopilotTool<any, any>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Copilot tool '${tool.name}' already registered`);
    }
    if (tool.parameters.type !== 'object') {
      throw new Error(
        `Copilot tool '${tool.name}' parameters.type must be 'object', got '${tool.parameters.type}'`,
      );
    }
    assertSchemaHasNoTenantKeys(tool.parameters, tool.name);
    assertSchemaHasNoResourceIds(tool.parameters, tool.name);
    this.tools.set(tool.name, tool);
  }

  getCopilotTools(): CopilotTool<any, any>[] {
    return Array.from(this.tools.values());
  }

  getCopilotToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getCopilotTool(name: string): CopilotTool<any, any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

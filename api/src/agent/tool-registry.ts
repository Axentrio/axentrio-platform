import type { ToolAdapter } from './tool-adapter';
import { KbSearchTool } from './tools/kb-search.tool';
import { EscalationTool } from './tools/escalation.tool';
import { CaptureLeadTool } from './tools/capture-lead.tool';
import type { Tenant } from '../database/entities/Tenant';
import type { BotSettings } from '../database/entities/Bot';
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';
import { listActiveModules, allModules } from '../modules';
import { getEntitlements } from '../billing/entitlements';

export class ToolRegistry {
  private builtinTools: Map<string, ToolAdapter>;

  constructor() {
    // Core tools every tenant gets. Capability tools (booking, future bespoke
    // work) live on Modules and are composed per tenant by the resolver.
    this.builtinTools = new Map();
    this.registerBuiltin(new KbSearchTool());
    this.registerBuiltin(new EscalationTool());
    this.registerBuiltin(new CaptureLeadTool());
  }

  private registerBuiltin(tool: ToolAdapter): void {
    this.builtinTools.set(tool.name, tool);
  }

  /** Every tool the platform ships: core built-ins + all catalog modules' tools. */
  getBuiltinToolNames(): string[] {
    return [
      ...this.builtinTools.keys(),
      ...allModules().flatMap((m) => m.tools.map((t) => t.name)),
    ];
  }

  /** The real ToolDefinition for a builtin tool by name (for the dry-run skill
   *  test, so inert catalog skills advertise the tool's actual parameters, not an
   *  empty stub). Undefined if the name isn't a builtin. */
  builtinToolDef(name: string): { name: string; description: string; parameters: Record<string, unknown> } | undefined {
    const t = this.builtinTools.get(name);
    return t ? { name: t.name, description: t.description, parameters: t.parameters } : undefined;
  }

  /**
   * Compose the tenant's tool set: core built-ins + the tools of every Module
   * the resolver says is active (feature-gated modules follow the tenant's
   * resolved entitlements — overrides and the free/non-active deny included;
   * enablement-gated modules follow their tenant_modules row). Fails closed
   * on resolution errors. `_botSettings` is kept on the signature (callers
   * still pass the resolved bot settings).
   */
  async getToolsForTenant(tenant: Tenant, _botSettings: BotSettings): Promise<ToolAdapter[]> {
    const tools: ToolAdapter[] = [];

    const kbSearch = this.builtinTools.get('kb_search');
    if (kbSearch) tools.push(kbSearch);

    const escalation = this.builtinTools.get('escalate_to_human');
    if (escalation) tools.push(escalation);

    // Gate capture_lead on the EFFECTIVE leadCapture entitlement (already folds
    // in the tenant feature-toggle). If the tool is loaded for a gated-off
    // tenant, the prompt tells the model it MUST capture + must not claim a
    // save without calling the tool — but the write path silently no-ops, so
    // the bot promises a save that never happens. Omit the tool instead (the
    // CONTACT DETAILS prompt block keys off tool presence, so it drops too).
    // Fail closed: if entitlements can't be resolved, omit rather than risk the
    // false-saved confirmation — matching the write path, which also fails closed.
    const captureLead = this.builtinTools.get('capture_lead');
    if (captureLead) {
      try {
        if ((await getEntitlements(tenant.id)).features.leadCapture) tools.push(captureLead);
      } catch (error) {
        logger.warn(`leadCapture entitlement check failed — capture_lead omitted for tenant ${tenant.id}`, { error });
      }
    }

    try {
      const active = await listActiveModules(tenant.id);
      for (const m of active) tools.push(...m.module.tools);
    } catch (error) {
      logger.warn(`Module resolution failed for tenant ${tenant.id} — no module tools`, { error });
    }

    try {
      const customTools = await this.loadCustomTools(tenant.id);
      tools.push(...customTools);
    } catch (error) {
      logger.warn(`Failed to load custom tools for tenant ${tenant.id}`, { error });
    }

    return tools;
  }

  private async loadCustomTools(_tenantId: string): Promise<ToolAdapter[]> {
    // tool_definitions table will be created in a future migration
    // For now, return empty — graceful degradation if table doesn't exist
    try {
      const repo = AppDataSource.getRepository('tool_definitions' as any);
      await (repo as any).find({ where: { tenantId: _tenantId, enabled: true } });
      return [];
    } catch {
      return [];
    }
  }
}

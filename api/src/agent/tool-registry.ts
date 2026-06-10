import type { ToolAdapter } from './tool-adapter';
import { KbSearchTool } from './tools/kb-search.tool';
import { EscalationTool } from './tools/escalation.tool';
import { CaptureLeadTool } from './tools/capture-lead.tool';
import type { Tenant } from '../database/entities/Tenant';
import type { BotSettings } from '../database/entities/Bot';
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';
import { listActiveModules, allModules } from '../modules';

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

    const captureLead = this.builtinTools.get('capture_lead');
    if (captureLead) tools.push(captureLead);

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

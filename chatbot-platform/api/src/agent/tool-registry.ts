import type { ToolAdapter } from './tool-adapter';
import { KbSearchTool } from './tools/kb-search.tool';
import {
  CheckAvailabilityTool,
  CreateBookingTool,
  ListBookingsTool,
  RescheduleBookingTool,
  CancelBookingTool,
} from './tools/booking.tool';
import { EscalationTool } from './tools/escalation.tool';
import type { Tenant } from '../database/entities/Tenant';
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';

const BOOKING_TOOLS = [
  'check_availability',
  'create_booking',
  'list_bookings',
  'reschedule_booking',
  'cancel_booking',
];

export class ToolRegistry {
  private builtinTools: Map<string, ToolAdapter>;

  constructor() {
    this.builtinTools = new Map();
    this.registerBuiltin(new KbSearchTool());
    this.registerBuiltin(new CheckAvailabilityTool());
    this.registerBuiltin(new CreateBookingTool());
    this.registerBuiltin(new ListBookingsTool());
    this.registerBuiltin(new RescheduleBookingTool());
    this.registerBuiltin(new CancelBookingTool());
    this.registerBuiltin(new EscalationTool());
  }

  private registerBuiltin(tool: ToolAdapter): void {
    this.builtinTools.set(tool.name, tool);
  }

  getBuiltinToolNames(): string[] {
    return Array.from(this.builtinTools.keys());
  }

  async getToolsForTenant(tenant: Tenant): Promise<ToolAdapter[]> {
    const tools: ToolAdapter[] = [];

    const kbSearch = this.builtinTools.get('kb_search');
    if (kbSearch) tools.push(kbSearch);

    const escalation = this.builtinTools.get('escalate_to_human');
    if (escalation) tools.push(escalation);

    const calcom = tenant.settings?.integrations?.calcom;
    if (calcom?.apiKey && calcom?.eventTypeId) {
      for (const name of BOOKING_TOOLS) {
        const tool = this.builtinTools.get(name);
        if (tool) tools.push(tool);
      }
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

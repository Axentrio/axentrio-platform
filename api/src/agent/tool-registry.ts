import type { ToolAdapter } from './tool-adapter';
import { KbSearchTool } from './tools/kb-search.tool';
import {
  CheckAvailabilityTool,
  CreateBookingTool,
  RequestAppointmentTool,
  ListBookingsTool,
  RescheduleBookingTool,
  CancelBookingTool,
} from './tools/booking.tool';
import { EscalationTool } from './tools/escalation.tool';
import { CaptureLeadTool } from './tools/capture-lead.tool';
import type { Tenant } from '../database/entities/Tenant';
import type { BotSettings } from '../database/entities/Bot';
import { AppDataSource } from '../database/data-source';
import { logger } from '../utils/logger';
import { getEntitlements } from '../billing/entitlements';

const BOOKING_TOOLS = [
  'check_availability',
  'create_booking',
  'request_appointment',
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
    this.registerBuiltin(new RequestAppointmentTool());
    this.registerBuiltin(new ListBookingsTool());
    this.registerBuiltin(new RescheduleBookingTool());
    this.registerBuiltin(new CancelBookingTool());
    this.registerBuiltin(new EscalationTool());
    this.registerBuiltin(new CaptureLeadTool());
  }

  private registerBuiltin(tool: ToolAdapter): void {
    this.builtinTools.set(tool.name, tool);
  }

  getBuiltinToolNames(): string[] {
    return Array.from(this.builtinTools.keys());
  }

  /**
   * Multi-bot Phase 4 (#16d): integrations config lives on Bot.settings, not
   * Tenant.settings. `_botSettings` is kept on the signature (callers still
   * pass the resolved bot settings) but booking is now tier-gated only — Cal.com
   * is shelved, so per-bot integration creds no longer affect tool selection.
   */
  async getToolsForTenant(tenant: Tenant, _botSettings: BotSettings): Promise<ToolAdapter[]> {
    const tools: ToolAdapter[] = [];

    const kbSearch = this.builtinTools.get('kb_search');
    if (kbSearch) tools.push(kbSearch);

    const escalation = this.builtinTools.get('escalate_to_human');
    if (escalation) tools.push(escalation);

    const captureLead = this.builtinTools.get('capture_lead');
    if (captureLead) tools.push(captureLead);

    // Booking tools gate on the resolved `bookings` feature (plan D6/D10) —
    // resolved entitlements, not raw tier, so per-tenant overrides and the
    // free/non-active deny apply. Mirrors buildIntegrationsConfig in
    // message-forwarding so the platform agent and the n8n payload stay in
    // lockstep on which bots can book. Fails closed on resolution errors.
    let bookingEnabled = false;
    try {
      bookingEnabled = (await getEntitlements(tenant.id)).features.bookings;
    } catch (error) {
      logger.warn(`Booking entitlement resolution failed for tenant ${tenant.id}`, { error });
    }
    if (bookingEnabled) {
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

/**
 * Per-bot skill readiness (composable-templates Phase 6). The SINGLE async
 * computation behind BOTH `GET /bots/:id/skill-readiness` and the bot-template
 * view's `perSkillStates` — so the two advisory surfaces can never disagree (the
 * dual-path drift risk in the plan). It reuses the EXACT Phase-3 machinery the
 * agent runtime uses (selectSkillIds → resolveSkillStates → readinessRefinement,
 * with the shared isBookingConfigured predicate), so it adds zero load to the
 * agent hot path while staying byte-faithful to what the runtime enforces.
 *
 * Error policy — fails CLOSED: a booking-config lookup error PROPAGATES, so the
 * readiness endpoint 5xxes rather than paint a misleading "ready". (The agent
 * runtime fails OPEN on the same lookup; the bot-template view wraps this call in
 * a try/catch so a transient blip never breaks the template picker.) A throw
 * INSIDE the per-skill readiness refinement is contained to that one skill (→
 * `error`) via safeReadiness.
 */
import { AppDataSource } from '../database/data-source';
import { AvailabilityRule } from '../database/entities/AvailabilityRule';
import { ServiceType } from '../database/entities/ServiceType';
import type { Bot } from '../database/entities/Bot';
import { listActiveModules } from './module-resolver';
import { getModule } from './module-catalog';
import { resolveSkillStates } from './skill-state';
import {
  readinessRefinement,
  safeReadiness,
  skillStatesToReadiness,
  BOOKING_SKILL_ID,
} from '../llm/skill-readiness';
import { isBookingConfigured } from '../scheduler/booking-readiness';
import { resolveBoundTemplates, selectSkillIds } from '../templates/template-resolver';
import { logger } from '../utils/logger';
import type { SkillReadinessDto } from '../contracts/skill-readiness';

export async function computeBotSkillReadiness(bot: Bot, tenantId: string): Promise<SkillReadinessDto[]> {
  const [resolvedTemplates, activeModules] = await Promise.all([
    resolveBoundTemplates(bot),
    listActiveModules(tenantId),
  ]);
  const activeModuleIds = activeModules.map((a) => a.module.id);

  // Selected skills = the UNION of every bound template's skills (H6) — identical to
  // the agent's own selection, so the readiness display and runtime never disagree.
  const selectedSkillIds = [...new Set(
    resolvedTemplates.flatMap((rt) =>
      selectSkillIds({ selectedSkillIds: rt.selectedSkillIds ?? null, expectedModules: rt.expectedModules ?? [] }),
    ),
  )];

  // Booking readiness — only when booking is ACTIVE (resolveSkillStates refines
  // active skills only). Same predicate + same gate set the agent uses. No
  // try/catch: a lookup error PROPAGATES (fail closed) up to the call site.
  let bookingConfigured = false;
  if (activeModuleIds.includes(BOOKING_SKILL_ID)) {
    const [rule, services] = await Promise.all([
      AppDataSource.getRepository(AvailabilityRule).findOne({ where: { botId: bot.id }, select: { id: true } }),
      AppDataSource.getRepository(ServiceType).find({
        where: { botId: bot.id, isActive: true, onlineBookable: true },
        select: { id: true, bookingMode: true },
      }),
    ]);
    bookingConfigured = isBookingConfigured(services, !!rule);
  }

  const skillStates = resolveSkillStates({
    selected: selectedSkillIds,
    active: activeModuleIds,
    gateKind: (id) => getModule(id)?.gate.kind,
    readiness: safeReadiness(
      (id) => readinessRefinement(id, { bookingConfigured }),
      (id, err) =>
        logger.warn('skill readiness refinement threw — skill degraded to error', {
          tenantId,
          botId: bot.id,
          skillId: id,
          err,
        }),
    ),
  });

  // Templates are the SOLE source of skills: the readiness list shows exactly the
  // skills the template composes (a selected-but-unentitled one still surfaces, as a
  // plan gap). No template → nothing shown (the bot answers from the KB only). Matches
  // the agent's runtime tool-gating so the two never disagree. Flag-gated.
  const composableEnabled = process.env.COMPOSABLE_TEMPLATES_ENABLED === 'true';
  const shown = composableEnabled
    ? Object.fromEntries(Object.entries(skillStates).filter(([id]) => selectedSkillIds.includes(id)))
    : skillStates;

  return skillStatesToReadiness(shown, (id) => getModule(id)?.displayName ?? id);
}

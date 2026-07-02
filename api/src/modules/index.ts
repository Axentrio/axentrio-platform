/**
 * Module registration — importing this module populates the catalog.
 * Adding a new Module = create its file, register it here, deploy. It stays
 * inert for every tenant until its gate passes (feature) or its
 * tenant_modules row is enabled (bespoke).
 */
import { registerModule } from './module-catalog';
import { bookingModule } from './booking.module';
import { leadCaptureSkill, handoffSkill } from './catalog-skills';

registerModule(bookingModule);
// Catalog-only skills: bindable + insightful, runtime-inert (no tools/section).
registerModule(leadCaptureSkill);
registerModule(handoffSkill);

export { registerModule, getModule, allModules, gatedToolNames, skillPromptAllowed } from './module-catalog';
export type { ModuleDefinition, ModuleGate, ModulePromptContext } from './module-catalog';
export {
  listActiveModules,
  isModuleActive,
  requireModule,
  invalidateModules,
  invalidateEntitlementsAndModules,
  type ActiveModule,
} from './module-resolver';

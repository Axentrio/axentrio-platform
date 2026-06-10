/**
 * Module registration — importing this module populates the catalog.
 * Adding a new Module = create its file, register it here, deploy. It stays
 * inert for every tenant until its gate passes (feature) or its
 * tenant_modules row is enabled (bespoke).
 */
import { registerModule } from './module-catalog';
import { bookingModule } from './booking.module';

registerModule(bookingModule);

export { registerModule, getModule, allModules } from './module-catalog';
export type { ModuleDefinition, ModuleGate, ModulePromptContext } from './module-catalog';
export {
  listActiveModules,
  isModuleActive,
  requireModule,
  invalidateModules,
  type ActiveModule,
} from './module-resolver';

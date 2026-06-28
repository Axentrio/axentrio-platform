/**
 * Capability-readiness registration — importing this module populates the
 * registry (mirrors `../modules`). Each capability file calls
 * `registerCapability` at import time. Adding a capability = create its file
 * under `capabilities/`, import it here, deploy.
 */
import './capabilities/booking.readiness';

export {
  registerCapability,
  getCapabilities,
  type CapabilityReadiness,
  type CapabilityKey,
  type ReadinessState,
  type ReadinessResult,
  type ReadinessBotCtx,
  type ReadinessCta,
} from './registry';

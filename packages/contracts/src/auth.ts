import type { OperatorRole } from './common';

/** GET /api/v1/auth/me */
export interface AuthMe {
  agentId: string;
  tenantId: string;
  role: OperatorRole;
  tenantName: string;
  email: string;
  locale: string | null;
}

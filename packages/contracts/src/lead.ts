export type LeadSource = 'tool' | 'manual' | 'import' | 'webhook';

/** Item in GET /api/v1/leads */
export interface Lead {
  id: string;
  sessionId?: string;
  botId?: string;
  name: string;
  email: string;
  phone?: string;
  source: LeadSource;
  notes?: string;
  createdAt: string;
}

/** GET /api/v1/leads (cursor-paginated). */
export interface LeadsPage {
  leads: Lead[];
  nextCursor?: string | null;
}

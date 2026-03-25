/**
 * Handoff Service — stub
 */

export class HandoffService {
  async requestHandoff(_data: Record<string, any>): Promise<{ id: string }> {
    return { id: `handoff_${Date.now()}` };
  }

  async releaseHandoff(_sessionId: string): Promise<void> {
    // Stub: no-op
  }
}

export default HandoffService;

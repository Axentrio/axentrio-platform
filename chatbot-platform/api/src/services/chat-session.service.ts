/**
 * Chat Session Service — stub
 */

export class ChatSessionService {
  async getSession(_sessionId: string): Promise<any> {
    return null;
  }

  async clearSessionContext(_sessionId: string): Promise<void> {
    // Stub: no-op
  }

  async transferSession(_sessionId: string, _options: { target: string; reason?: string }): Promise<void> {
    // Stub: no-op
  }
}

export default ChatSessionService;

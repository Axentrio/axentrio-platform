/**
 * Message Service — stub
 */

export class MessageService {
  async createMessage(_data: Record<string, any>): Promise<{ id: string }> {
    return { id: `msg_${Date.now()}` };
  }

  async editMessage(_messageId: string, _data: Record<string, any>): Promise<void> {
    // Stub: no-op
  }

  async deleteMessage(_messageId: string): Promise<void> {
    // Stub: no-op
  }
}

export default MessageService;

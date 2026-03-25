/**
 * User Service — stub
 * Provides user-related operations for the webhook service.
 */

export class UserService {
  async updateUserContext(_userId: string, _context: Record<string, unknown>): Promise<void> {
    // Stub: no-op
  }
}

export default UserService;

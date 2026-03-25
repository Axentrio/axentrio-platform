/**
 * WebSocket Index
 * Export all WebSocket-related functions
 */

export {
  initializeSocketIO,
  getIO,
  emitToRoom,
  emitToTenantAgents,
  emitToSession,
  emitToAgent,
} from './socket.handler';

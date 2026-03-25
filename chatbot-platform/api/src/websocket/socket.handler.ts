/**
 * WebSocket Handler
 * Socket.io with optional Redis adapter for multi-server scaling
 * Room format: `${tenantId}:${sessionId}`
 * Supports dual auth: JWT (portal agents) + API key (widget visitors)
 */
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server as HttpServer } from 'http';
import { logger } from '../utils/logger';
import { getPubClient, getSubClient, isRedisAvailable } from '../config/redis';
import { validateSocketTenant, TenantSocket } from '../middleware/tenant.middleware';
import { checkSocketRateLimit } from '../middleware/rate-limit.middleware';
import { verifyToken } from '@clerk/backend';
import { config } from '../config/environment';
import { resolveClerkIds } from '../middleware/clerk.middleware';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';

// Socket event types
interface MessageSendData {
  sessionId: string;
  content: string;
  type?: 'text' | 'image' | 'file';
  metadata?: Record<string, unknown>;
}

interface TypingIndicatorData {
  sessionId: string;
  isTyping: boolean;
}

interface HandoffRequestData {
  sessionId: string;
  reason?: string;
}

interface HandoffResponseData {
  sessionId: string;
  accepted: boolean;
  agentId?: string;
}

// Repositories
const sessionRepository = AppDataSource.getRepository(ChatSession);
const messageRepository = AppDataSource.getRepository(Message);

// Socket.io instance
let io: SocketIOServer | null = null;

/**
 * Initialize Socket.io server with optional Redis adapter
 */
export function initializeSocketIO(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*', // Configure based on your needs
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
  });

  // Setup Redis adapter only when Redis is available
  const pub = getPubClient();
  const sub = getSubClient();
  if (pub && sub && isRedisAvailable()) {
    io.adapter(createAdapter(pub, sub));
    logger.info('Socket.io Redis adapter enabled');
  } else {
    logger.warn('Socket.io running without Redis adapter (single-server mode)');
  }

  // ---- Dual-auth connection middleware ----
  io.use(async (socket, next) => {
    try {
      // Mode 1: Portal agent (Clerk token)
      if (socket.handshake.auth?.token) {
        try {
          const verified = await verifyToken(socket.handshake.auth.token, {
            secretKey: config.clerk.secretKey,
          });
          const clerkUserId = verified.sub;
          const clerkOrgId = verified.org_id;

          if (!clerkOrgId) {
            return next(new Error('Authentication error: Organization required'));
          }

          const dbIds = await resolveClerkIds(clerkUserId, clerkOrgId);
          if (!dbIds) {
            return next(new Error('Authentication error: User not provisioned'));
          }

          socket.data.user = {
            id: dbIds.agentId,
            tenantId: dbIds.tenantId,
            role: dbIds.userRole,
            type: 'agent',
          };
          socket.data.tenantId = dbIds.tenantId;
          return next();
        } catch {
          return next(new Error('Authentication error: Invalid token'));
        }
      }
      // Mode 2: Widget (API key in query)
      if (socket.handshake.query?.apiKey) {
        // Attach minimal widget session info
        socket.data.user = {
          id: (socket.handshake.query.visitorId as string) || socket.id,
          email: '',
          role: 'visitor',
          tenantId: socket.handshake.query.tenantId as string || '',
          type: 'widget' as const,
        };
        socket.data.tenantId = socket.handshake.query.tenantId as string || '';
        return next();
      }
      return next(new Error('Authentication required'));
    } catch (err) {
      return next(err instanceof Error ? err : new Error('Authentication failed'));
    }
  });

  // Tenant middleware
  io.use(validateSocketTenant as any);

  // Handle connections
  io.on('connection', handleConnection);

  logger.info('Socket.io server initialized');
  return io;
}

/**
 * Handle new socket connections
 */
function handleConnection(socket: TenantSocket): void {
  const user = socket.data.user;
  const tenantId = socket.data.tenantId;

  logger.info(`Socket connected: ${socket.id}`, {
    userId: user?.id,
    tenantId,
    type: user?.type,
  });

  // Join tenant room for broadcast messages
  if (tenantId) {
    socket.join(`tenant:${tenantId}`);
  }

  // Handle agent-specific setup
  if (user?.type === 'agent') {
    handleAgentConnection(socket);
  }

  // Setup event handlers
  setupEventHandlers(socket);

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    handleDisconnection(socket, reason);
  });

  // Send connection acknowledgment
  socket.emit('connection:ack', {
    socketId: socket.id,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Handle agent connection
 */
function handleAgentConnection(socket: TenantSocket): void {
  const user = socket.data.user;

  // Join agent-specific room
  socket.join(`agent:${user!.id}`);

  // Join agents pool for tenant
  if (socket.data.tenantId) {
    socket.join(`agents:${socket.data.tenantId}`);
  }

  logger.info(`Agent connected: ${user!.id}`);

  // Notify other agents
  socket.to(`agents:${socket.data.tenantId}`).emit('agent:online', {
    agentId: user!.id,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Setup socket event handlers
 */
function setupEventHandlers(socket: TenantSocket): void {
  // Message events
  socket.on('message:send', (data: MessageSendData) => handleMessageSend(socket, data));
  socket.on('message:read', (data: { messageId: string }) => handleMessageRead(socket, data));

  // Typing indicator
  socket.on('typing:indicator', (data: TypingIndicatorData) =>
    handleTypingIndicator(socket, data)
  );

  // Handoff events
  socket.on('handoff:request', (data: HandoffRequestData) => handleHandoffRequest(socket, data));
  socket.on('handoff:accept', (data: HandoffResponseData) => handleHandoffAccept(socket, data));
  socket.on('handoff:reject', (data: HandoffResponseData) => handleHandoffReject(socket, data));

  // Session events
  socket.on('session:join', (data: { sessionId: string }) => handleSessionJoin(socket, data));
  socket.on('session:leave', (data: { sessionId: string }) => handleSessionLeave(socket, data));

  // Presence events
  socket.on('presence:update', (data: { status: string }) => handlePresenceUpdate(socket, data));

  // Portal agent events
  socket.on('agent:join', (data: { sessionId: string }) => handleAgentJoin(socket, data));
  socket.on('agent:leave', (data: { sessionId: string }) => handleAgentLeave(socket, data));
  socket.on('agent:status', (data: { status: string }) => handlePresenceUpdate(socket, data));
  socket.on('handoff:decline', (data: HandoffResponseData) => handleHandoffReject(socket, data));
}

/**
 * Handle agent joining a specific session
 */
async function handleAgentJoin(socket: TenantSocket, data: { sessionId: string }): Promise<void> {
  const tenantId = socket.data.tenantId;
  if (!tenantId) return;

  const roomName = `${tenantId}:${data.sessionId}`;
  await socket.join(roomName);

  io?.to(roomName).emit('agent:joined', {
    agentId: socket.data.user?.id,
    sessionId: data.sessionId,
    timestamp: new Date().toISOString(),
  });

  logger.debug(`Agent ${socket.data.user?.id} joined session ${data.sessionId}`);
}

/**
 * Handle agent leaving a specific session
 */
function handleAgentLeave(socket: TenantSocket, data: { sessionId: string }): void {
  const tenantId = socket.data.tenantId;
  if (!tenantId) return;

  const roomName = `${tenantId}:${data.sessionId}`;
  socket.leave(roomName);

  io?.to(roomName).emit('agent:left', {
    agentId: socket.data.user?.id,
    sessionId: data.sessionId,
    timestamp: new Date().toISOString(),
  });

  logger.debug(`Agent ${socket.data.user?.id} left session ${data.sessionId}`);
}

/**
 * Handle message send event
 */
async function handleMessageSend(socket: TenantSocket, data: MessageSendData): Promise<void> {
  try {
    // Rate limiting check
    const allowed = await checkSocketRateLimit(socket.id, socket.data.tenantId);
    if (!allowed) {
      socket.emit('error', { message: 'Rate limit exceeded' });
      return;
    }

    const { sessionId, content, type = 'text', metadata } = data;
    const user = socket.data.user;
    const tenantId = socket.data.tenantId;

    if (!sessionId || !content) {
      socket.emit('error', { message: 'Invalid message data' });
      return;
    }

    // Verify session exists and belongs to tenant
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    // Determine sender type
    const senderType = user?.type === 'agent' ? 'agent' : 'user';
    const senderId = user?.id || socket.id;

    // Save message to database
    const message = messageRepository.create({
      sessionId,
      tenantId: tenantId!,
      participantId: senderId,
      type,
      content,
      metadata: metadata || undefined,
    } as any);

    const savedMessage = await messageRepository.save(message) as unknown as Message;

    // Update session last activity
    session.updateActivity();
    await sessionRepository.save(session);

    // Broadcast message to room
    const roomName = `${tenantId}:${sessionId}`;
    const messageData = {
      id: savedMessage.id,
      type: savedMessage.type,
      content: savedMessage.content,
      status: savedMessage.status,
      createdAt: savedMessage.createdAt,
      senderType,
      timestamp: new Date().toISOString(),
    };

    // Emit to all clients in the room (including sender for confirmation)
    io?.to(roomName).emit('message:receive', messageData);

    // Also emit to tenant agents for notifications
    io?.to(`agents:${tenantId}`).emit('message:new', {
      sessionId,
      message: messageData,
    });

    logger.debug(`Message sent in room ${roomName}`, {
      messageId: savedMessage.id,
      senderType,
    });
  } catch (error) {
    logger.error('Error handling message:send:', error);
    socket.emit('error', { message: 'Failed to send message' });
  }
}

/**
 * Handle message read event
 */
async function handleMessageRead(
  socket: TenantSocket,
  data: { messageId: string }
): Promise<void> {
  try {
    const { messageId } = data;
    const tenantId = socket.data.tenantId;

    const message = await messageRepository.findOne({
      where: { id: messageId },
      relations: ['session'],
    });

    if (!message || message.session.tenantId !== tenantId) {
      socket.emit('error', { message: 'Message not found' });
      return;
    }

    message.markAsRead();
    await messageRepository.save(message);

    // Notify room about read status
    const roomName = `${tenantId}:${message.sessionId}`;
    io?.to(roomName).emit('message:read', {
      messageId: message.id,
      readAt: message.readAt,
    });
  } catch (error) {
    logger.error('Error handling message:read:', error);
    socket.emit('error', { message: 'Failed to mark message as read' });
  }
}

/**
 * Handle typing indicator
 */
function handleTypingIndicator(socket: TenantSocket, data: TypingIndicatorData): void {
  const { sessionId, isTyping } = data;
  const tenantId = socket.data.tenantId;
  const user = socket.data.user;

  if (!sessionId || !tenantId) {
    return;
  }

  const roomName = `${tenantId}:${sessionId}`;
  const senderType = user?.type === 'agent' ? 'agent' : 'user';

  // Broadcast typing indicator to room (excluding sender)
  socket.to(roomName).emit('typing:indicator', {
    sessionId,
    isTyping,
    senderType,
    timestamp: new Date().toISOString(),
  });

  logger.debug(`Typing indicator: ${isTyping} in room ${roomName}`);
}

/**
 * Handle handoff request
 */
async function handleHandoffRequest(
  socket: TenantSocket,
  data: HandoffRequestData
): Promise<void> {
  try {
    const { sessionId, reason } = data;
    const tenantId = socket.data.tenantId;

    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    // Update session status
    session.requestHandoff();
    if (session.metadata) {
      (session.metadata as any).handoffReason = reason || 'User requested';
    }
    await sessionRepository.save(session);

    // Notify agents about handoff request
    io?.to(`agents:${tenantId}`).emit('handoff:requested', {
      sessionId,
      reason,
      requestedAt: new Date().toISOString(),
    });

    // Confirm to requester
    socket.emit('handoff:request:ack', {
      sessionId,
      status: 'pending',
    });

    logger.info(`Handoff requested for session ${sessionId}`, { reason });
  } catch (error) {
    logger.error('Error handling handoff:request:', error);
    socket.emit('error', { message: 'Failed to request handoff' });
  }
}

/**
 * Handle handoff accept
 */
async function handleHandoffAccept(
  socket: TenantSocket,
  data: HandoffResponseData
): Promise<void> {
  try {
    const { sessionId, agentId } = data;
    const tenantId = socket.data.tenantId;
    const user = socket.data.user;

    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    // Update session
    session.assignAgent(agentId || user?.id || '');
    await sessionRepository.save(session);

    const roomName = `${tenantId}:${sessionId}`;

    // Notify session room
    io?.to(roomName).emit('handoff:accepted', {
      sessionId,
      agentId: agentId || user?.id,
      agentName: user?.email,
      acceptedAt: new Date().toISOString(),
    });

    // Notify other agents
    io?.to(`agents:${tenantId}`).emit('handoff:assigned', {
      sessionId,
      agentId: agentId || user?.id,
    });

    logger.info(`Handoff accepted for session ${sessionId}`, {
      agentId: agentId || user?.id,
    });
  } catch (error) {
    logger.error('Error handling handoff:accept:', error);
    socket.emit('error', { message: 'Failed to accept handoff' });
  }
}

/**
 * Handle handoff reject
 */
async function handleHandoffReject(
  socket: TenantSocket,
  data: HandoffResponseData
): Promise<void> {
  try {
    const { sessionId } = data;
    const tenantId = socket.data.tenantId;

    // Just notify that an agent rejected - session stays pending
    io?.to(`agents:${tenantId}`).emit('handoff:rejected', {
      sessionId,
      rejectedBy: socket.data.user?.id,
      rejectedAt: new Date().toISOString(),
    });

    logger.info(`Handoff rejected for session ${sessionId}`);
  } catch (error) {
    logger.error('Error handling handoff:reject:', error);
    socket.emit('error', { message: 'Failed to reject handoff' });
  }
}

/**
 * Handle session join
 */
async function handleSessionJoin(
  socket: TenantSocket,
  data: { sessionId: string }
): Promise<void> {
  try {
    const { sessionId } = data;
    const tenantId = socket.data.tenantId;

    if (!tenantId) {
      socket.emit('error', { message: 'Tenant not identified' });
      return;
    }

    // Verify session exists and belongs to tenant
    const session = await sessionRepository.findOne({
      where: { id: sessionId, tenantId },
    });

    if (!session) {
      socket.emit('error', { message: 'Session not found' });
      return;
    }

    const roomName = `${tenantId}:${sessionId}`;
    await socket.join(roomName);

    // Store session ID in socket data
    socket.data.sessionId = sessionId;

    // Notify room about user joining
    socket.to(roomName).emit('session:user:joined', {
      sessionId,
      userId: socket.data.user?.id,
      joinedAt: new Date().toISOString(),
    });

    socket.emit('session:joined', {
      sessionId,
      roomName,
      status: session.status,
    });

    logger.debug(`Socket ${socket.id} joined room ${roomName}`);
  } catch (error) {
    logger.error('Error handling session:join:', error);
    socket.emit('error', { message: 'Failed to join session' });
  }
}

/**
 * Handle session leave
 */
function handleSessionLeave(socket: TenantSocket, data: { sessionId: string }): void {
  const { sessionId } = data;
  const tenantId = socket.data.tenantId;

  if (!tenantId) {
    return;
  }

  const roomName = `${tenantId}:${sessionId}`;
  socket.leave(roomName);

  // Notify room about user leaving
  socket.to(roomName).emit('session:user:left', {
    sessionId,
    userId: socket.data.user?.id,
    leftAt: new Date().toISOString(),
  });

  socket.emit('session:left', { sessionId });

  logger.debug(`Socket ${socket.id} left room ${roomName}`);
}

/**
 * Handle presence update
 */
function handlePresenceUpdate(
  socket: TenantSocket,
  data: { status: string }
): void {
  const { status } = data;
  const tenantId = socket.data.tenantId;
  const user = socket.data.user;

  if (user?.type === 'agent' && tenantId) {
    // Broadcast agent status to other agents
    socket.to(`agents:${tenantId}`).emit('agent:status', {
      agentId: user.id,
      status,
      updatedAt: new Date().toISOString(),
    });

    logger.debug(`Agent ${user.id} status updated to ${status}`);
  }
}

/**
 * Handle socket disconnection
 */
function handleDisconnection(socket: TenantSocket, reason: string): void {
  const user = socket.data.user;
  const tenantId = socket.data.tenantId;

  logger.info(`Socket disconnected: ${socket.id}`, {
    userId: user?.id,
    tenantId,
    reason,
  });

  // Notify other agents if this was an agent
  if (user?.type === 'agent' && tenantId) {
    socket.to(`agents:${tenantId}`).emit('agent:offline', {
      agentId: user.id,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Get Socket.io instance
 */
export function getIO(): SocketIOServer {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
}

/**
 * Emit event to a specific room
 */
export function emitToRoom(
  roomName: string,
  event: string,
  data: Record<string, unknown>
): void {
  if (!io) {
    logger.error('Cannot emit - Socket.io not initialized');
    return;
  }
  io.to(roomName).emit(event, data);
}

/**
 * Emit event to all agents in a tenant
 */
export function emitToTenantAgents(
  tenantId: string,
  event: string,
  data: Record<string, unknown>
): void {
  emitToRoom(`agents:${tenantId}`, event, data);
}

/**
 * Emit event to a specific session
 */
export function emitToSession(
  tenantId: string,
  sessionId: string,
  event: string,
  data: Record<string, unknown>
): void {
  const roomName = `${tenantId}:${sessionId}`;
  emitToRoom(roomName, event, data);
}

/**
 * Emit event to a specific agent
 */
export function emitToAgent(
  agentId: string,
  event: string,
  data: Record<string, unknown>
): void {
  emitToRoom(`agent:${agentId}`, event, data);
}

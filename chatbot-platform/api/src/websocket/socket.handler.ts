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
import { checkEventRateLimit } from './socket-rate-limit';
import { verifyToken } from '@clerk/backend';
import { config } from '../config/environment';
import { resolveClerkIds } from '../middleware/clerk.middleware';
import { DeepPartial } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message } from '../database/entities/Message';
import { Tenant } from '../database/entities/Tenant';
import { Participant } from '../database/entities/Participant';
import { forwardMessageToN8n } from '../services/message-forwarding.service';
import { encrypt } from '../utils/encryption';
import { routeOutboundMessage } from '../channels/outbound-router';

// Per-session mutex to serialise message saves and prevent race conditions
// on messageCount increments and session updates.
const sessionLocks = new Map<string, Promise<void>>();
function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  // Chain fn after previous work, swallowing prior errors so this fn still runs
  const result = prev.then(() => fn(), () => fn());
  // Track the void chain so the next caller waits for us
  const done = result.then(() => {}, () => {});
  sessionLocks.set(sessionId, done);
  // Clean up when nothing else has chained after us
  done.then(() => { if (sessionLocks.get(sessionId) === done) sessionLocks.delete(sessionId); });
  return result;
}

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
 * Authenticate a socket connection (extracted for timeout wrapping).
 * Throws on failure instead of calling next() — the caller handles next().
 */
async function authenticateSocket(socket: TenantSocket): Promise<void> {
  // Mode 1: Portal agent (Clerk token)
  if (socket.handshake.auth?.token) {
    let verified;
    try {
      verified = await verifyToken(socket.handshake.auth.token, {
        secretKey: config.clerk.secretKey,
      });
    } catch {
      throw new Error('Authentication error: Invalid token');
    }

    const clerkUserId = verified.sub;
    const clerkOrgId = verified.org_id;

    if (clerkOrgId) {
      const dbIds = await resolveClerkIds(clerkUserId, clerkOrgId);
      if (dbIds) {
        socket.data.user = {
          id: dbIds.agentId,
          email: '',
          tenantId: dbIds.tenantId,
          role: dbIds.userRole,
          type: 'agent',
        };
        socket.data.tenantId = dbIds.tenantId;
        return;
      }
    }

    const { User } = await import('../database/entities/User');
    const { Agent } = await import('../database/entities/Agent');
    const userRepo = AppDataSource.getRepository(User);
    const agentRepo = AppDataSource.getRepository(Agent);

    const user = await userRepo.findOne({ where: { clerkUserId } });
    if (!user) throw new Error('Authentication error: User not provisioned');

    const agent = await agentRepo.findOne({ where: { userId: user.id } });
    if (!agent) throw new Error('Authentication error: Agent not provisioned');

    socket.data.user = {
      id: agent.id,
      email: user.email || '',
      tenantId: user.tenantId,
      role: user.role,
      type: 'agent',
    };
    socket.data.tenantId = user.tenantId;
    return;
  }

  // Mode 2: Widget (API key in query)
  if (socket.handshake.query?.apiKey) {
    const tenantRepo = AppDataSource.getRepository(Tenant);
    const tenant = await tenantRepo.findOne({
      where: { apiKey: socket.handshake.query.apiKey as string },
    });
    if (!tenant) throw new Error('Authentication error: Invalid API key');

    socket.data.user = {
      id: (socket.handshake.query.visitorId as string) || socket.id,
      email: '',
      role: 'agent' as const,
      tenantId: tenant.id,
      type: 'widget' as const,
    };
    socket.data.tenantId = tenant.id;
    return;
  }

  throw new Error('Authentication required');
}

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

  // ---- Dual-auth connection middleware (with 3s timeout) ----
  const AUTH_TIMEOUT_MS = 3000;

  io.use(async (socket, next) => {
    try {
      await Promise.race([
        authenticateSocket(socket as TenantSocket),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Authentication timeout')), AUTH_TIMEOUT_MS)
        ),
      ]);
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error('Authentication failed'));
    }
  });

  // Tenant middleware
  io.use((socket, next) => validateSocketTenant(socket as TenantSocket, next));

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

function withRateLimit(
  socket: TenantSocket,
  eventName: string,
  handler: (...args: unknown[]) => Promise<void> | void
) {
  socket.on(eventName, async (...args: unknown[]) => {
    const tenantId = socket.data.tenantId;
    if (!tenantId) return;

    const { allowed, retryAfter } = await checkEventRateLimit(
      socket.id,
      tenantId,
      eventName
    );
    if (!allowed) {
      socket.emit('error', { code: 'RATE_LIMITED', event: eventName, retryAfter });
      return;
    }
    await handler(...args);
  });
}

/**
 * Setup socket event handlers
 */
function setupEventHandlers(socket: TenantSocket): void {
  withRateLimit(socket, 'message:send', (data) => handleMessageSend(socket, data as MessageSendData));
  withRateLimit(socket, 'message:read', (data) => handleMessageRead(socket, data as { messageId: string }));
  withRateLimit(socket, 'typing:indicator', (data) => handleTypingIndicator(socket, data as TypingIndicatorData));
  withRateLimit(socket, 'handoff:request', (data) => handleHandoffRequest(socket, data as HandoffRequestData));
  withRateLimit(socket, 'handoff:accept', (data) => handleHandoffAccept(socket, data as HandoffResponseData));
  withRateLimit(socket, 'handoff:reject', (data) => handleHandoffReject(socket, data as HandoffResponseData));
  withRateLimit(socket, 'session:join', (data) => handleSessionJoin(socket, data as { sessionId: string }));
  withRateLimit(socket, 'session:leave', (data) => handleSessionLeave(socket, data as { sessionId: string }));
  withRateLimit(socket, 'presence:update', (data) => handlePresenceUpdate(socket, data as { status: string }));
  withRateLimit(socket, 'agent:join', (data) => handleAgentJoin(socket, data as { sessionId: string }));
  withRateLimit(socket, 'agent:leave', (data) => handleAgentLeave(socket, data as { sessionId: string }));
  withRateLimit(socket, 'agent:status', (data) => handlePresenceUpdate(socket, data as { status: string }));
  withRateLimit(socket, 'handoff:decline', (data) => handleHandoffReject(socket, data as HandoffResponseData));
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
  const { sessionId, content, type = 'text', metadata } = data;
  const user = socket.data.user;
  const tenantId = socket.data.tenantId;

  if (!sessionId || !content) {
    socket.emit('error', { message: 'Invalid message data' });
    return;
  }

  try {
    // Serialise per-session to prevent concurrent messageCount races
    await withSessionLock(sessionId, async () => {
      // Verify session exists and belongs to tenant
      const session = await sessionRepository.findOne({
        where: { id: sessionId, tenantId },
      });

      if (!session) {
        socket.emit('error', { message: 'Session not found' });
        return;
      }

      if (session.status === 'closed') {
        socket.emit('error', { message: 'Session is closed' });
        return;
      }

      // Determine sender type
      const senderType = user?.type === 'agent' ? 'agent' : 'user';
      const senderId = socket.data.participantId || user?.id || socket.id;

      // Encrypt message content before saving
      const encryptedContent = encrypt(content);

      // Save message to database
      const message = messageRepository.create({
        sessionId,
        tenantId: tenantId!,
        participantId: senderId,
        type,
        content: encryptedContent,
        contentEncrypted: true,
        metadata: metadata || undefined,
      } as DeepPartial<Message>);

      const savedMessage = await messageRepository.save(message);

      // Update session last activity and message count
      session.messageCount = (session.messageCount || 0) + 1;
      session.updateActivity();
      await sessionRepository.save(session);

      // Broadcast message to room — use original plain text
      const roomName = `${tenantId}:${sessionId}`;
      const messageData = {
        id: savedMessage.id,
        type: savedMessage.type,
        content,
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

      // Forward visitor messages to n8n if applicable (fire-and-forget, outside lock scope)
      if (senderType === 'user') {
        forwardMessageToN8n(session, savedMessage).catch((err) => {
          logger.error('Error in n8n message forwarding:', err);
        });
      }

      // Route agent replies to external channels (WebSocket already emitted above)
      if (senderType === 'agent' && session.channel !== 'widget') {
        routeOutboundMessage(
          { type: 'text', content },
          { sessionId, tenantId: session.tenantId, messageId: savedMessage.id },
          undefined, // Skip WebSocket — already emitted above
        ).catch((err) => {
          logger.error('Error routing agent reply to external channel:', err);
        });
      }
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
    session.metadata = {
      ...session.metadata,
      customData: {
        ...session.metadata?.customData,
        handoffReason: reason || 'User requested',
      },
    };
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

    // For widget users, resolve the participant ID so messages can be saved
    if (socket.data.user?.type === 'widget') {
      const participantRepo = AppDataSource.getRepository(Participant);
      const participant = await participantRepo.findOne({
        where: { sessionId, type: 'user' },
        order: { joinedAt: 'DESC' },
      });
      if (participant) {
        socket.data.participantId = participant.id;
      }
    }

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

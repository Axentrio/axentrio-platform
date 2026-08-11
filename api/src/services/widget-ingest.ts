/**
 * Everything that has to happen when a customer says something in the widget.
 *
 * This was inline in `POST /widget/message` and had exactly one caller, so nothing was wrong with
 * it. Then a second thing started producing customer messages - picking an address from a
 * suggestion list - and the shape of the problem changed: an address the customer CHOSE has to
 * enter the conversation the same way an address they TYPED does, or the two diverge in ways
 * nobody planned.
 *
 * THE TRAP THIS EXISTS TO CLOSE. The obvious implementation of a second producer is to write a
 * `Message` row and call `scheduleTurn`. That looks complete and is not: `scheduleTurn` schedules
 * a message that has ALREADY been persisted, and everything that makes a message real happens
 * before it - the participant the message is attributed to, the session's own message count, and
 * the socket event every open dashboard is waiting on. A second producer that skipped those would
 * put the customer's address in the transcript while the operator's inbox showed nothing, the
 * counts drifted, and - because the turn still ran - the Agent answered a message no human could
 * see arriving.
 *
 * So there is one path, and both callers take it.
 */
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Message, type MessageType } from '../database/entities/Message';
import { Participant } from '../database/entities/Participant';
import { encrypt } from '../utils/encryption';
import { emitToSession } from '../websocket/socket.handler';
import { scheduleTurn } from './turn-coalescer';
import { logger } from '../utils/logger';
import { touchAddressBinding } from '../booking/travel/address-binding';

export interface IngestedMessage {
  id: string;
  content: string;
  type: string;
  createdAt: Date;
}

/**
 * Record a customer message and set the Agent answering it.
 *
 * `content` is PLAINTEXT. It is encrypted on the way into the column and emitted in the clear on
 * the socket, which is the split the existing handler already made: the database is at rest, the
 * socket is an authenticated live channel to the operator watching this conversation.
 */
export async function ingestWidgetCustomerMessage(
  session: ChatSession,
  content: string,
  options: { type?: MessageType; metadata?: Record<string, unknown> } = {}
): Promise<IngestedMessage> {
  const { type = 'text', metadata } = options;
  const messageRepository = AppDataSource.getRepository(Message);
  const participantRepository = AppDataSource.getRepository(Participant);
  const sessionRepository = AppDataSource.getRepository(ChatSession);

  // One anonymous visitor participant per session, created on first message. Looked up rather
  // than assumed, because the second producer can be the first thing a customer does.
  let participant = await participantRepository.findOne({
    where: { sessionId: session.id, type: 'user', isDeleted: false },
  });
  if (!participant) {
    participant = participantRepository.create({
      sessionId: session.id,
      type: 'user',
      name: 'Visitor',
      isAnonymous: true,
      joinedAt: new Date(),
    });
    await participantRepository.save(participant);
  }

  const message = messageRepository.create({
    sessionId: session.id,
    tenantId: session.tenantId,
    participantId: participant.id,
    type,
    content: encrypt(content),
    contentEncrypted: true,
    metadata: metadata ?? {},
    status: 'sent',
    sentAt: new Date(),
  });
  await messageRepository.save(message);

  session.incrementMessageCount();
  await sessionRepository.save(session);

  // Plaintext on the wire: this is the live feed an operator is reading, and a dashboard showing
  // ciphertext is a dashboard nobody can use.
  emitToSession(session.tenantId, session.id, 'message:receive', {
    id: message.id,
    sessionId: message.sessionId,
    participantId: message.participantId,
    participantType: 'user',
    type: message.type,
    content,
    metadata: message.metadata,
    timestamp: message.createdAt.toISOString(),
  });

  // The address binding's window measures SILENCE, not the age of the choice - a customer forty
  // minutes into a booking has not lost the address they picked. This is the only place that can
  // honestly say "the customer is still here", so it is the only place the refresh belongs.
  // Detached: a Redis hiccup must not fail a message that is already saved.
  void touchAddressBinding(session.id);

  // Detached deliberately, as it always was: the customer's message is saved and acknowledged
  // whatever the Agent does next, and a scheduling failure must not read to them as a lost message.
  scheduleTurn(session, message).catch((err) => {
    logger.error('Error scheduling turn (widget):', err);
  });

  return {
    id: message.id,
    content,
    type: message.type,
    createdAt: message.createdAt,
  };
}

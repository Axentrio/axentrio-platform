/**
 * Conversation command routes (B-PR2b) — the acknowledged REST surface for
 * operator takeover / reply / release / cancel / close (plan §B1/D4).
 *
 * POST /chats/:sessionId/takeover  { idempotencyKey, mode, hours? }
 * POST /chats/:sessionId/release   { idempotencyKey }
 * POST /chats/:sessionId/cancel    { idempotencyKey }   // HANDOFF_REQUESTED -> BOT_OWNED
 * POST /chats/:sessionId/close     { idempotencyKey }
 * POST /chats/:sessionId/reset     { idempotencyKey }  // super_admin testing reset
 * POST /chats/:sessionId/messages  { clientMessageId, content }
 *
 * Every mutation goes through the conversation command service (one DB
 * transaction, row locks, idempotency replay); this layer does auth,
 * validation, and post-commit socket fan-out only (D4: commands mutate,
 * sockets distribute committed facts).
 *
 * Mounted at /chats BEFORE chat.routes. The one path collision is
 * POST /:sessionId/close, which the WIDGET also uses (widget-token authed, in
 * chat.routes): a request carrying a widget JWT is passed through to that
 * router untouched.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import {
  requireClerkAuth,
  autoProvision,
} from "../middleware/clerk.middleware";
import { resolveTenantContext, requireSuperAdmin } from "../middleware/super-admin.middleware";
import {
  validateTenant,
  type TenantRequest,
} from "../middleware/tenant.middleware";
import { verifyToken } from "../middleware/auth.middleware";
import {
  asyncHandler,
  ApiError,
  BadRequestError,
  NotFoundError,
} from "../middleware/error-handler";
import { sendSuccess, sendCreated } from "../utils/response";
import { emitToSession, emitToTenantAgents } from "../websocket/socket.handler";
import {
  emitConversationUpsertForSession,
  emitMessageCreatedForSession,
} from "../realtime/conversation-events";
import {
  deliverOperatorReply,
  claimFailedForRetry,
  type OperatorReply,
} from "../channels/delivery-state";
import { MAX_MESSAGE_CONTENT_CHARS } from "../guardrails/classify";
import {
  conversationCommands,
  type HumanMessageAttachment,
} from "../services/conversation-command.service";
import { ResetScratchClearError } from "../services/conversation-reset-state";
import { isUuid } from "../utils/uuid";
import { getUploadService } from "../file-handling/upload.service";
import { getChannelAdapter } from "../channels/channel-registry";
import {
  channelSupportsAttachment,
  outboundAttachmentType,
} from "../channels/attachment-type";
import type { ChannelType } from "../database/entities/ChannelConnection";
import { AppDataSource } from "../database/data-source";

const router = Router();

/** Pass widget-token requests through to the legacy widget close route in
 *  chat.routes (same mount). Anything else is treated as an operator command. */
function forwardWidgetTokens(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = verifyToken(header.substring(7));
      if (payload.type === "widget") return next("router");
    } catch {
      // Not a local widget JWT (e.g. a Clerk token) — operator path.
    }
  }
  next();
}

const agentAuth = [
  requireClerkAuth,
  autoProvision,
  resolveTenantContext,
  validateTenant,
] as const;

/** Tenant scope + super-admin impersonation flag for command service calls. */
function commandScope(req: TenantRequest) {
  return {
    tenantId: req.tenant!.id,
    // Role is DB-provisioned, not client-supplied. Session still must belong
    // to req.tenant (org-switch OR X-Tenant-Context). Agent row may live on
    // the super-admin's home tenant — user_id is globally unique.
    allowForeignAgent: req.user?.role === "super_admin",
  };
}

function requireIdempotencyKey(body: unknown): string {
  const key = (body as { idempotencyKey?: unknown })?.idempotencyKey;
  if (typeof key !== "string" || !key.trim() || key.length > 128) {
    throw new BadRequestError("idempotencyKey is required (max 128 chars)");
  }
  return key;
}

/**
 * Backward-compat variant for the routes the SHIPPED portal already posts to
 * with an empty body (Inbox.tsx: /takeover, /close, /release). Absent key ⇒
 * the command executes non-idempotently (transactional state change only, no
 * conversation_commands replay row). New clients (PR 3) always send a key.
 */
export function optionalIdempotencyKey(body: unknown): string | undefined {
  const key = (body as { idempotencyKey?: unknown })?.idempotencyKey;
  if (key === undefined || key === null) return undefined;
  if (typeof key !== "string" || !key.trim() || key.length > 128) {
    throw new BadRequestError(
      "idempotencyKey must be a non-empty string (max 128 chars)",
    );
  }
  return key;
}

/**
 * POST /chats/:sessionId/takeover
 * Claim the conversation for the calling operator, with
 * `mode: 'indefinite' | 'timed'` (B-PR5a exposes 'timed' now that the expiry
 * worker exists - the codex-locked ordering). A timed claim requires an
 * integer `hours` 1..24 (the DB CHECK range); anything else is a 400 with the
 * stable code `invalid_takeover_hours`.
 *
 * A same-owner re-claim that carries an EXPLICIT mode updates the
 * human_control_* policy in place (the B-PR5b "change duration" action).
 *
 * Backward compat (B2 fix): the SHIPPED portal posts here with an EMPTY body
 * (Inbox.tsx:198), so key and mode are optional — absent mode defaults to
 * 'indefinite' (and can never rewrite an existing policy), absent key executes
 * non-idempotently.
 */
router.post(
  "/:sessionId/takeover",
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const idempotencyKey = optionalIdempotencyKey(req.body);
    const { mode = "indefinite", hours } = req.body as {
      mode?: string;
      hours?: unknown;
    };
    const modeIsExplicit = (req.body as { mode?: unknown })?.mode !== undefined;

    if (mode !== "indefinite" && mode !== "timed") {
      throw new BadRequestError("mode must be 'indefinite' or 'timed'");
    }
    if (
      mode === "timed" &&
      (typeof hours !== "number" ||
        !Number.isInteger(hours) ||
        hours < 1 ||
        hours > 24)
    ) {
      throw new ApiError(
        "A timed takeover requires an integer hours value between 1 and 24",
        400,
        "invalid_takeover_hours",
        { hours },
      );
    }

    const result = await conversationCommands.claimConversation(
      req.params.sessionId,
      req.user!.id,
      mode === "timed"
        ? { mode: "timed", hours: hours as number }
        : { mode: "indefinite" },
      idempotencyKey,
      { ...commandScope(req), updatePolicyIfOwned: modeIsExplicit },
    );

    if (result.outcome === "claimed" && !result.replayed) {
      emitToSession(req.tenant!.id, req.params.sessionId, "handoff:accepted", {
        sessionId: req.params.sessionId,
        agent: { id: req.user!.id },
        acceptedAt: new Date().toISOString(),
      });
      emitToTenantAgents(req.tenant!.id, "handoff:assigned", {
        sessionId: req.params.sessionId,
        agentId: req.user!.id,
      });
      // B-PR3a: normalized ownership event to BOTH rooms, post-commit.
      await emitConversationUpsertForSession(
        req.params.sessionId,
        req.tenant!.id,
      );
    } else if (result.policyUpdated && !result.replayed) {
      // Policy changed on an already-owned conversation: no legacy handoff
      // emits (nothing was accepted or assigned), but the portal countdown
      // needs the committed upsert.
      await emitConversationUpsertForSession(
        req.params.sessionId,
        req.tenant!.id,
      );
    }

    sendSuccess(res, {
      outcome: result.outcome,
      conversation: result.conversation,
    });
  }),
);

/**
 * POST /chats/:sessionId/release — HUMAN_OWNED -> BOT_OWNED by the assigned operator.
 * Key optional (B2 fix): the shipped portal posts here with an empty body (Inbox.tsx:289).
 */
router.post(
  "/:sessionId/release",
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const idempotencyKey = optionalIdempotencyKey(req.body);
    const { reason } = req.body as { reason?: string };

    const result = await conversationCommands.releaseConversation(
      req.params.sessionId,
      req.user!.id,
      idempotencyKey,
      { ...commandScope(req), reason },
    );

    if (result.outcome === "released" && !result.replayed) {
      emitToSession(req.tenant!.id, req.params.sessionId, "handoff:returned", {
        sessionId: req.params.sessionId,
        reason,
        returnedAt: new Date().toISOString(),
      });
      // B-PR3a: a release previously reached ONLY the session room — the
      // agents-room gap this PR closes.
      await emitConversationUpsertForSession(
        req.params.sessionId,
        req.tenant!.id,
      );
    }

    sendSuccess(res, {
      outcome: result.outcome,
      conversation: result.conversation,
    });
  }),
);

/**
 * POST /chats/:sessionId/cancel — HANDOFF_REQUESTED -> BOT_OWNED (operator decline).
 */
router.post(
  "/:sessionId/cancel",
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const idempotencyKey = requireIdempotencyKey(req.body);
    const { reason } = req.body as { reason?: string };

    const result = await conversationCommands.cancelHandoff(
      req.params.sessionId,
      { kind: "agent", agentId: req.user!.id },
      idempotencyKey,
      { ...commandScope(req), reason },
    );

    if (result.outcome === "cancelled" && !result.replayed) {
      emitToTenantAgents(req.tenant!.id, "handoff:rejected", {
        sessionId: req.params.sessionId,
        rejectedBy: req.user!.id,
        rejectedAt: new Date().toISOString(),
      });
      // B-PR3a: normalized ownership event to BOTH rooms, post-commit.
      await emitConversationUpsertForSession(
        req.params.sessionId,
        req.tenant!.id,
      );
    }

    sendSuccess(res, {
      outcome: result.outcome,
      conversation: result.conversation,
    });
  }),
);

/**
 * POST /chats/:sessionId/close — any -> CLOSED (operator). Widget-token
 * requests fall through to the legacy widget close route.
 * Key optional (B2 fix): the shipped portal posts here with an empty body (Inbox.tsx:272).
 */
router.post(
  "/:sessionId/close",
  forwardWidgetTokens,
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const idempotencyKey = optionalIdempotencyKey(req.body);
    const { reason } = req.body as { reason?: string };

    const result = await conversationCommands.closeConversation(
      req.params.sessionId,
      { kind: "agent", agentId: req.user!.id },
      idempotencyKey,
      { ...commandScope(req), reason },
    );

    if (result.outcome === "closed" && !result.replayed) {
      emitToSession(req.tenant!.id, req.params.sessionId, "session:closed", {
        sessionId: req.params.sessionId,
        endedAt: new Date().toISOString(),
        closedBy: "agent",
      });
      // B-PR3a: a close previously reached ONLY the session room — the
      // agents-room gap this PR closes.
      await emitConversationUpsertForSession(
        req.params.sessionId,
        req.tenant!.id,
      );
    }

    sendSuccess(res, {
      outcome: result.outcome,
      conversation: result.conversation,
    });
  }),
);

/**
 * POST /chats/:sessionId/reset — super-admin testing reset. Closes the
 * conversation (next inbound starts a new session) and clears this identity's
 * customer-memory, draft booking/tool scratch, intake, Redis session state,
 * and live bookings (so the next chat is not alreadyHeld). Missing Redis or a
 * Redis that cannot drop booking:confirm / booking:offered / gr:loop returns
 * 503 reset_scratch_incomplete so the operator can retry. The 503 still fans
 * out session:closed + conversation:upsert because the DB close already committed.
 */
async function emitResetClosedFanout(tenantId: string, sessionId: string): Promise<void> {
  emitToSession(tenantId, sessionId, "session:closed", {
    sessionId,
    endedAt: new Date().toISOString(),
    closedBy: "agent",
  });
  await emitConversationUpsertForSession(sessionId, tenantId);
}

router.post(
  "/:sessionId/reset",
  ...agentAuth,
  requireSuperAdmin,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const idempotencyKey = optionalIdempotencyKey(req.body);

    let result;
    try {
      result = await conversationCommands.resetConversation(
        req.params.sessionId,
        { kind: "agent", agentId: req.user!.id },
        idempotencyKey,
        { ...commandScope(req), reason: "Super-admin testing reset" },
      );
    } catch (err) {
      if (err instanceof ResetScratchClearError) {
        await emitResetClosedFanout(req.tenant!.id, req.params.sessionId);
      }
      throw err;
    }

    if (!result.replayed) {
      await emitResetClosedFanout(req.tenant!.id, req.params.sessionId);
    }

    sendSuccess(res, {
      outcome: result.outcome,
      conversation: result.conversation,
      scratchCleared: result.scratchCleared ?? false,
      transcriptSessionIds: result.transcriptSessionIds ?? [req.params.sessionId],
    });
  }),
);

/**
 * POST /chats/:sessionId/messages — acknowledged operator reply (B2).
 * First reply auto-claims an unclaimed conversation in the same transaction;
 * a duplicate clientMessageId returns the original message; another operator's
 * ownership is a 409 (the client keeps the draft).
 */
router.post(
  "/:sessionId/messages",
  ...agentAuth,
  asyncHandler(async (req: TenantRequest, res: Response) => {
    const { clientMessageId, content, attachment: attachmentBody } = req.body as {
      clientMessageId?: string;
      content?: string;
      attachment?: { uploadSessionId?: string };
    };
    if (typeof clientMessageId !== "string" || !clientMessageId.trim()) {
      throw new BadRequestError("clientMessageId is required");
    }
    const text = typeof content === "string" ? content : "";
    if (text.length > MAX_MESSAGE_CONTENT_CHARS) {
      throw new BadRequestError("Message too long");
    }

    let humanAttachment: HumanMessageAttachment | null = null;
    let deliveryAttachment: OperatorReply["attachment"] = null;

    if (attachmentBody != null) {
      const uploadSessionId = attachmentBody.uploadSessionId;
      if (!isUuid(uploadSessionId)) {
        throw new BadRequestError("attachment.uploadSessionId must be a UUID");
      }
      const upload = await getUploadService().getSession(uploadSessionId);
      if (
        !upload ||
        upload.tenantId !== req.tenant!.id ||
        upload.chatSessionId !== req.params.sessionId
      ) {
        throw new NotFoundError("Upload session not found");
      }
      if (upload.status !== "ready") {
        throw new ApiError(
          "Attachment has not finished scanning",
          400,
          "ATTACHMENT_NOT_READY",
        );
      }

      const channel = await sessionChannel(req.params.sessionId, req.tenant!.id);
      const external = !!channel && channel !== "widget";
      if (external && channel) {
        const adapter = getChannelAdapter(channel as ChannelType);
        if (
          adapter &&
          !channelSupportsAttachment(
            adapter.outboundTransport.getCapabilities(),
            outboundAttachmentType(upload.mimeType),
          )
        ) {
          throw new ApiError(
            "This channel does not accept this attachment type",
            400,
            "ATTACHMENT_UNSUPPORTED_ON_CHANNEL",
          );
        }
      }

      humanAttachment = {
        uploadSessionId,
        fileName: upload.originalName,
        fileSize: upload.fileSize,
        fileType: upload.mimeType,
      };
      deliveryAttachment = {
        uploadSessionId,
        fileKey: upload.fileKey,
        mimeType: upload.mimeType,
        fileName: upload.originalName,
        fileSize: upload.fileSize,
      };
    } else if (!text.trim()) {
      throw new BadRequestError("content is required");
    }

    const result = await conversationCommands.sendHumanMessage(
      req.params.sessionId,
      req.user!.id,
      clientMessageId,
      text,
      humanAttachment,
      commandScope(req),
    );

    const msgType: "text" | "image" | "file" = humanAttachment
      ? humanAttachment.fileType.startsWith("image/")
        ? "image"
        : "file"
      : "text";
    const attachmentMeta = humanAttachment
      ? {
          uploadSessionId: humanAttachment.uploadSessionId,
          fileName: humanAttachment.fileName,
          fileSize: humanAttachment.fileSize,
          fileType: humanAttachment.fileType,
        }
      : {};

    if (result.outcome === "sent") {
      const sessionId = req.params.sessionId;
      const messageData = {
        id: result.message.id,
        sessionId,
        chatId: sessionId,
        type: msgType,
        content: text,
        status: "sent",
        createdAt: result.message.createdAt,
        sender: "agent",
        senderType: "agent",
        timestamp: new Date().toISOString(),
        metadata: { clientMessageId, ...attachmentMeta },
      };
      emitToSession(req.tenant!.id, sessionId, "message:receive", messageData);
      emitToTenantAgents(req.tenant!.id, "message:new", {
        sessionId,
        message: messageData,
      });
      if (result.autoClaimed) {
        emitToTenantAgents(req.tenant!.id, "handoff:assigned", {
          sessionId,
          agentId: req.user!.id,
        });
      }
      await emitMessageCreatedForSession(sessionId, req.tenant!.id, {
        id: result.message.id,
        sessionId,
        type: msgType,
        content: text,
        senderType: "agent",
        status: "sent",
        createdAt: result.message.createdAt,
        metadata: { clientMessageId, ...attachmentMeta },
      });
      const channel = await sessionChannel(sessionId, req.tenant!.id);
      const external = !!channel && channel !== "widget";
      if (result.conversation && external) {
        void deliverOperatorReply({
          sessionId,
          tenantId: req.tenant!.id,
          messageId: result.message.id,
          clientMessageId,
          content: text,
          createdAt: result.message.createdAt,
          type: msgType,
          metadata: { clientMessageId, ...attachmentMeta },
          attachment: deliveryAttachment,
        });
      }
    } else if (result.outcome === "duplicate") {
      const sessionId = req.params.sessionId;
      const channel = await sessionChannel(sessionId, req.tenant!.id);
      const external = !!channel && channel !== "widget";
      if (external) {
        // Resolve attachment from the persisted row BEFORE claiming retry.
        // claimFailedForRetry flips failed → sending; if the upload is no longer
        // ready we must not claim (row would stick in sending with no retry path).
        const retryAttachment = await resolveDuplicateAttachment(result.message.id);
        if (retryAttachment !== "skip" && (await claimFailedForRetry(result.message.id))) {
          const retryType: "text" | "image" | "file" = retryAttachment
            ? retryAttachment.mimeType.startsWith("image/")
              ? "image"
              : "file"
            : "text";
          const retryMeta = retryAttachment
            ? {
                clientMessageId,
                uploadSessionId: retryAttachment.uploadSessionId,
                fileName: retryAttachment.fileName,
                fileSize: retryAttachment.fileSize,
                fileType: retryAttachment.mimeType,
              }
            : { clientMessageId };
          void deliverOperatorReply({
            sessionId,
            tenantId: req.tenant!.id,
            messageId: result.message.id,
            clientMessageId,
            content: text,
            createdAt: result.message.createdAt,
            type: retryType,
            metadata: retryMeta,
            attachment: retryAttachment,
          });
        }
      }
    }

    sendCreated(res, {
      outcome: result.outcome,
      autoClaimed: result.autoClaimed,
      message: result.message,
      conversation: result.conversation,
    });
  }),
);

/** Widget sessions deliver over the socket only; everything else goes through
 *  the outbound router. Read once post-commit. */
async function sessionChannel(
  sessionId: string,
  tenantId: string,
): Promise<string | null> {
  const rows = (await AppDataSource.query(
    `SELECT channel FROM chat_sessions WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId],
  )) as Array<{ channel: string | null }>;
  return rows[0]?.channel ?? null;
}

async function resolveDuplicateAttachment(
  messageId: string,
): Promise<OperatorReply["attachment"] | "skip"> {
  const rows = (await AppDataSource.query(
    `SELECT type, metadata FROM messages WHERE id = $1`,
    [messageId],
  )) as Array<{ type: string; metadata: Record<string, unknown> | null }>;
  const meta = rows[0]?.metadata ?? {};
  const uploadSessionId = meta.uploadSessionId;
  if (typeof uploadSessionId !== "string") return null;
  const upload = await getUploadService().getSession(uploadSessionId);
  if (!upload || upload.status !== "ready") return "skip";
  return {
    uploadSessionId,
    fileKey: upload.fileKey,
    mimeType: upload.mimeType,
    fileName: upload.originalName,
    fileSize: upload.fileSize,
  };
}

export default router;

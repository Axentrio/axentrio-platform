/**
 * Schema Index
 * Exports all n8n message schemas and validation utilities
 */

export {
  outboundMessageSchema,
  outboundMessageValidationOptions,
} from './outbound-message.schema';

export {
  inboundMessageSchema,
  handoffActionSchema,
  fileRequestSchema,
  inboundMessageValidationOptions,
} from './inbound-message.schema';

export {
  quickReplySchema,
  quickReplyGroupSchema,
  carouselCardSchema,
  templateMessageSchema,
  locationRequestSchema,
  quickReplyValidationOptions,
} from './quick-reply.schema';

// Re-export types
export type { JSONSchema7 } from 'json-schema';

/**
 * Inbound Message Schema
 * Defines the message format received FROM n8n TO the chatbot platform
 */

import { JSONSchema7 } from 'json-schema';

export const inboundMessageSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://chatbot-platform.com/schemas/inbound-message.json',
  title: 'Inbound Message',
  description: 'Message sent from n8n to chatbot platform',
  type: 'object',
  required: ['action', 'sessionId'],
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: [
        'message.send',
        'message.edit',
        'message.delete',
        'typing.start',
        'typing.stop',
        'handsoff.trigger',
        'handsoff.release',
        'file.request',
        'session.clear',
        'session.transfer',
        'user.update',
        'webhook.register',
        'webhook.unregister',
      ],
      description: 'The action to perform',
    },
    sessionId: {
      type: 'string',
      format: 'uuid',
      description: 'Target session identifier',
    },
    tenantId: {
      type: 'string',
      format: 'uuid',
      description: 'Tenant identifier (optional, for verification)',
    },
    payload: {
      type: 'object',
      additionalProperties: true,
      properties: {
        type: {
          type: 'string',
          enum: ['text', 'image', 'video', 'audio', 'file', 'quick_reply', 'carousel', 'template', 'typing'],
          description: 'Type of response content',
        },
        content: {
          oneOf: [
            { type: 'string', maxLength: 10000 },
            { type: 'object' },
          ],
          description: 'Response content',
        },
        quickReplies: {
          type: 'array',
          maxItems: 10,
          items: {
            oneOf: [
              { type: 'string', maxLength: 20 },
              {
                type: 'object',
                required: ['title'],
                properties: {
                  title: { type: 'string', maxLength: 20 },
                  value: { type: 'string' },
                  action: { type: 'string' },
                  icon: { type: 'string' },
                },
              },
            ],
          },
          description: 'Quick reply options',
        },
        buttons: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', maxLength: 20 },
              type: { type: 'string', enum: ['postback', 'url', 'phone'] },
              value: { type: 'string' },
              url: { type: 'string', format: 'uri' },
            },
          },
        },
        attachments: {
          type: 'array',
          maxItems: 5,
          items: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', format: 'uri' },
              type: { type: 'string' },
              filename: { type: 'string' },
              size: { type: 'number' },
            },
          },
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
    delay: {
      type: 'number',
      minimum: 0,
      maximum: 30000,
      default: 0,
      description: 'Delay in milliseconds before sending the message',
    },
    priority: {
      type: 'string',
      enum: ['low', 'normal', 'high', 'urgent'],
      default: 'normal',
      description: 'Message priority',
    },
    options: {
      type: 'object',
      additionalProperties: true,
      properties: {
        ephemeral: {
          type: 'boolean',
          default: false,
          description: 'Message disappears after being read',
        },
        silent: {
          type: 'boolean',
          default: false,
          description: 'Send without notification',
        },
        requireConfirmation: {
          type: 'boolean',
          default: false,
          description: 'Require user confirmation before sending',
        },
      },
    },
  },
};

// Extended schema for handoff actions
export const handoffActionSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://chatbot-platform.com/schemas/handoff-action.json',
  title: 'Handoff Action',
  type: 'object',
  required: ['action', 'sessionId'],
  properties: {
    action: {
      type: 'string',
      enum: ['handsoff.trigger', 'handsoff.release'],
    },
    sessionId: { type: 'string', format: 'uuid' },
    payload: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        queue: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
        agentId: { type: 'string' },
        department: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
    },
  },
};

// Schema for file request action
export const fileRequestSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://chatbot-platform.com/schemas/file-request.json',
  title: 'File Request',
  type: 'object',
  required: ['action', 'sessionId', 'payload'],
  properties: {
    action: { type: 'string', enum: ['file.request'] },
    sessionId: { type: 'string', format: 'uuid' },
    payload: {
      type: 'object',
      required: ['types'],
      properties: {
        types: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['image', 'document', 'video', 'audio', 'any'],
          },
        },
        maxSize: { type: 'number', default: 10485760 }, // 10MB default
        maxFiles: { type: 'number', default: 1 },
        accept: { type: 'string' }, // MIME types, e.g., "image/*,.pdf"
        prompt: { type: 'string' },
      },
    },
  },
};

// Validation options
export const inboundMessageValidationOptions = {
  strict: true,
  removeAdditional: 'all' as const,
  useDefaults: true,
  coerceTypes: true,
};

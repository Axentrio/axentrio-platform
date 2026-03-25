/**
 * Outbound Message Schema
 * Defines the message format sent FROM the chatbot platform TO n8n
 */

import { JSONSchema7 } from 'json-schema';

export const outboundMessageSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://chatbot-platform.com/schemas/outbound-message.json',
  title: 'Outbound Message',
  description: 'Message sent from chatbot platform to n8n webhook',
  type: 'object',
  required: ['event', 'tenantId', 'sessionId', 'timestamp', 'payload'],
  additionalProperties: false,
  properties: {
    event: {
      type: 'string',
      enum: [
        'message.received',
        'message.sent',
        'session.started',
        'session.ended',
        'user.typing',
        'file.uploaded',
        'handsoff.requested',
        'handsoff.accepted',
        'handsoff.released',
      ],
      description: 'The event type being triggered',
    },
    tenantId: {
      type: 'string',
      format: 'uuid',
      description: 'Unique identifier for the tenant/organization',
    },
    sessionId: {
      type: 'string',
      format: 'uuid',
      description: 'Unique identifier for the chat session',
    },
    timestamp: {
      type: 'string',
      format: 'date-time',
      description: 'ISO 8601 timestamp of the event',
    },
    payload: {
      type: 'object',
      required: ['type'],
      additionalProperties: true,
      properties: {
        type: {
          type: 'string',
          enum: ['text', 'image', 'video', 'file', 'audio', 'location', 'contact'],
          description: 'Type of message content',
        },
        content: {
          oneOf: [
            { type: 'string', maxLength: 10000 },
            { type: 'object' },
          ],
          description: 'Message content (text or structured data)',
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          properties: {
            filename: { type: 'string' },
            mimeType: { type: 'string' },
            size: { type: 'number', minimum: 0 },
            width: { type: 'number' },
            height: { type: 'number' },
            duration: { type: 'number' },
            url: { type: 'string', format: 'uri' },
          },
        },
      },
    },
    user: {
      type: 'object',
      additionalProperties: true,
      properties: {
        anonymousId: {
          type: 'string',
          format: 'uuid',
          description: 'Anonymous unique identifier for the user',
        },
        externalId: {
          type: 'string',
          description: 'External user ID if authenticated',
        },
        email: {
          type: 'string',
          format: 'email',
          description: 'User email if known',
        },
        name: {
          type: 'string',
          description: 'User name if known',
        },
        browser: {
          type: 'string',
          description: 'User agent string',
        },
        ip: {
          type: 'string',
          description: 'Hashed IP address',
        },
        geo: {
          type: 'object',
          properties: {
            country: { type: 'string' },
            countryCode: { type: 'string', minLength: 2, maxLength: 2 },
            region: { type: 'string' },
            city: { type: 'string' },
            timezone: { type: 'string' },
            lat: { type: 'number' },
            lng: { type: 'number' },
          },
        },
        device: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['desktop', 'mobile', 'tablet'] },
            os: { type: 'string' },
            browser: { type: 'string' },
            version: { type: 'string' },
          },
        },
        customData: {
          type: 'object',
          additionalProperties: true,
          description: 'Custom user data defined by tenant',
        },
      },
    },
    context: {
      type: 'object',
      additionalProperties: true,
      properties: {
        previousMessages: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            required: ['role', 'content', 'timestamp'],
            properties: {
              role: {
                type: 'string',
                enum: ['user', 'assistant', 'system'],
              },
              content: { type: 'string' },
              timestamp: { type: 'string', format: 'date-time' },
              metadata: { type: 'object' },
            },
          },
        },
        intent: {
          type: 'string',
          description: 'Detected user intent (if available)',
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Intent confidence score',
        },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' },
              value: { type: 'string' },
              confidence: { type: 'number' },
            },
          },
        },
        pageUrl: {
          type: 'string',
          format: 'uri',
          description: 'Current page URL where chat is active',
        },
        referrer: {
          type: 'string',
          format: 'uri',
          description: 'Referrer URL',
        },
        utmParams: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            medium: { type: 'string' },
            campaign: { type: 'string' },
            term: { type: 'string' },
            content: { type: 'string' },
          },
        },
        customContext: {
          type: 'object',
          additionalProperties: true,
          description: 'Custom context defined by tenant',
        },
      },
    },
  },
};

// Schema validation options
export const outboundMessageValidationOptions = {
  strict: true,
  removeAdditional: 'all' as const,
  useDefaults: true,
  coerceTypes: false,
};

/**
 * Quick Reply Schema
 * Defines the format for quick reply buttons and interactive elements
 */

import { JSONSchema7 } from 'json-schema';

// Base quick reply schema
export const quickReplySchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://chatbot-platform.com/schemas/quick-reply.json',
  title: 'Quick Reply',
  description: 'Quick reply button configuration',
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      description: 'Unique identifier for the quick reply',
    },
    title: {
      type: 'string',
      maxLength: 20,
      description: 'Display text for the quick reply button',
    },
    value: {
      type: 'string',
      description: 'Value sent when quick reply is selected (defaults to title)',
    },
    action: {
      type: 'string',
      enum: ['send', 'url', 'phone', 'email', 'postback', 'location', 'camera'],
      default: 'send',
      description: 'Action type when quick reply is clicked',
    },
    icon: {
      type: 'string',
      description: 'Emoji or icon URL for the quick reply',
    },
    style: {
      type: 'object',
      properties: {
        backgroundColor: { type: 'string' },
        textColor: { type: 'string' },
        borderColor: { type: 'string' },
        borderRadius: { type: 'number' },
      },
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Additional metadata for the quick reply',
    },
    disabled: {
      type: 'boolean',
      default: false,
    },
    visible: {
      type: 'boolean',
      default: true,
    },
  },
};

// Quick reply group schema
export const quickReplyGroupSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://chatbot-platform.com/schemas/quick-reply-group.json',
  title: 'Quick Reply Group',
  type: 'object',
  required: ['items'],
  properties: {
    id: { type: 'string' },
    layout: {
      type: 'string',
      enum: ['horizontal', 'vertical', 'grid', 'carousel'],
      default: 'horizontal',
    },
    columns: {
      type: 'number',
      minimum: 1,
      maximum: 4,
      default: 2,
    },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { $ref: 'https://chatbot-platform.com/schemas/quick-reply.json' },
    },
    persist: {
      type: 'boolean',
      default: false,
      description: 'Whether quick replies persist after selection',
    },
    dismissOnSelect: {
      type: 'boolean',
      default: true,
      description: 'Whether to hide quick replies after one is selected',
    },
  },
};

// Carousel card schema
export const carouselCardSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://chatbot-platform.com/schemas/carousel-card.json',
  title: 'Carousel Card',
  type: 'object',
  required: ['title'],
  properties: {
    id: { type: 'string' },
    title: {
      type: 'string',
      maxLength: 80,
    },
    subtitle: {
      type: 'string',
      maxLength: 80,
    },
    imageUrl: {
      type: 'string',
      format: 'uri',
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
          payload: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          webviewHeightRatio: { type: 'string', enum: ['compact', 'tall', 'full'] },
        },
      },
    },
    defaultAction: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['url'] },
        url: { type: 'string', format: 'uri' },
      },
    },
  },
};

// Template message schema
export const templateMessageSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://chatbot-platform.com/schemas/template-message.json',
  title: 'Template Message',
  type: 'object',
  required: ['type', 'template'],
  properties: {
    type: { type: 'string', enum: ['template'] },
    template: {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['generic', 'button', 'receipt', 'list', 'carousel'],
        },
        // Generic template (carousel-like)
        elements: {
          type: 'array',
          maxItems: 10,
          items: { $ref: 'https://chatbot-platform.com/schemas/carousel-card.json' },
        },
        // Button template
        text: { type: 'string', maxLength: 640 },
        buttons: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', maxLength: 20 },
              type: { type: 'string', enum: ['postback', 'url', 'phone'] },
              payload: { type: 'string' },
              url: { type: 'string', format: 'uri' },
            },
          },
        },
      },
    },
  },
};

// Location request schema
export const locationRequestSchema: JSONSchema7 = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://chatbot-platform.com/schemas/location-request.json',
  title: 'Location Request',
  type: 'object',
  required: ['action'],
  properties: {
    action: { type: 'string', enum: ['location.request'] },
    prompt: { type: 'string' },
    options: {
      type: 'object',
      properties: {
        enableHighAccuracy: { type: 'boolean', default: false },
        timeout: { type: 'number', default: 10000 },
        maximumAge: { type: 'number', default: 0 },
      },
    },
  },
};

// Validation helper
export const quickReplyValidationOptions = {
  strict: true,
  removeAdditional: 'all' as const,
  useDefaults: true,
};

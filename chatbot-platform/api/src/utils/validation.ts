/**
 * Validation utilities — stub implementation
 * Used by n8n webhook controller for JSON schema validation.
 */

import { JSONSchema7 } from 'json-schema';

export interface ValidationOptions {
  coerceTypes?: boolean;
  removeAdditional?: boolean | 'all' | 'failing';
  useDefaults?: boolean;
  strict?: boolean;
}

export interface ValidationResult<T = unknown> {
  valid: boolean;
  data?: T;
  errors?: string[];
}

export function validateJsonSchema<T = unknown>(
  data: unknown,
  schema: JSONSchema7,
  _options?: ValidationOptions
): ValidationResult<T> {
  // Stub: basic required field check based on JSON Schema
  if (schema.type === 'object' && schema.required && typeof data === 'object' && data !== null) {
    const missing = schema.required.filter(
      (field: string) => !(field in (data as Record<string, unknown>))
    );
    if (missing.length > 0) {
      return {
        valid: false,
        errors: missing.map((f: string) => `Missing required field: ${f}`),
      };
    }
  }

  return { valid: true, data: data as T };
}

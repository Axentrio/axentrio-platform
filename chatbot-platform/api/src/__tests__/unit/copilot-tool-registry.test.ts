/**
 * Unit: CopilotToolRegistry + schema denylist enforcement.
 *
 * Covers PR4 invariants enforced at registration time:
 *   - Tenant-key denylist (recursive, case-insensitive) rejects any
 *     tool whose `parameters` declares a tenant-binding key
 *   - Resource-id check rejects v1 tools declaring `*Id`/`*_id` args
 *   - V1 registry's actual tool names == `V1_COPILOT_TOOL_NAMES` exactly
 *   - Duplicate registration throws
 *
 * Database-free — these tests poke pure constructor + validation logic.
 */
import { describe, it, expect } from 'vitest';
import {
  CopilotToolRegistry,
  V1_COPILOT_TOOL_NAMES,
} from '../../copilot/tools/registry';
import {
  assertSchemaHasNoTenantKeys,
  type CopilotTool,
  type CopilotToolParameterSchema,
} from '../../copilot/tools/types';
import { buildV1CopilotToolRegistry } from '../../copilot/tools';

function makeTool(
  overrides: Partial<CopilotTool<any, any>> = {},
): CopilotTool<any, any> {
  return {
    name: 'testTool',
    description: 'test',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return {};
    },
    ...overrides,
  };
}

describe('assertSchemaHasNoTenantKeys', () => {
  it('accepts a schema with no forbidden keys', () => {
    expect(() =>
      assertSchemaHasNoTenantKeys(
        { type: 'object', properties: { query: { type: 'string' } } },
        't',
      ),
    ).not.toThrow();
  });

  it('rejects top-level tenantId', () => {
    expect(() =>
      assertSchemaHasNoTenantKeys(
        { type: 'object', properties: { tenantId: { type: 'string' } } },
        't',
      ),
    ).toThrow(/tenantId/);
  });

  it('rejects tenant_id (snake case)', () => {
    expect(() =>
      assertSchemaHasNoTenantKeys(
        { type: 'object', properties: { tenant_id: { type: 'string' } } },
        't',
      ),
    ).toThrow(/tenant_id/);
  });

  it('rejects TenantId (mixed case)', () => {
    expect(() =>
      assertSchemaHasNoTenantKeys(
        { type: 'object', properties: { TenantId: { type: 'string' } } },
        't',
      ),
    ).toThrow(/TenantId/);
  });

  it('rejects orgId, organizationId, clerkOrgId, customerId', () => {
    for (const key of ['orgId', 'organizationId', 'clerkOrgId', 'customerId']) {
      expect(() =>
        assertSchemaHasNoTenantKeys(
          { type: 'object', properties: { [key]: { type: 'string' } } },
          't',
        ),
      ).toThrow(new RegExp(key));
    }
  });

  it('walks nested properties', () => {
    const schema = {
      type: 'object',
      properties: {
        filters: {
          type: 'object',
          properties: { tenantId: { type: 'string' } },
        },
      },
    };
    expect(() => assertSchemaHasNoTenantKeys(schema, 't')).toThrow(/tenantId/);
  });

  it('walks items (array element schemas)', () => {
    const schema = {
      type: 'object',
      properties: {
        list: {
          type: 'array',
          items: { type: 'object', properties: { tenant_id: {} } },
        },
      },
    };
    expect(() => assertSchemaHasNoTenantKeys(schema, 't')).toThrow(/tenant_id/);
  });

  it('walks anyOf / oneOf / allOf combinators', () => {
    for (const combinator of ['anyOf', 'oneOf', 'allOf']) {
      const schema = {
        type: 'object',
        properties: {
          filter: {
            [combinator]: [
              { type: 'object', properties: { harmless: {} } },
              { type: 'object', properties: { customerId: {} } },
            ],
          },
        },
      };
      expect(() => assertSchemaHasNoTenantKeys(schema, 't')).toThrow(/customerId/);
    }
  });

  it('walks $defs', () => {
    const schema = {
      type: 'object',
      $defs: { sub: { type: 'object', properties: { tenant: {} } } },
      properties: {},
    };
    expect(() => assertSchemaHasNoTenantKeys(schema, 't')).toThrow(/tenant/);
  });

  it('walks additionalProperties when it is a schema object', () => {
    const schema = {
      type: 'object',
      properties: {
        bag: {
          type: 'object',
          additionalProperties: { type: 'object', properties: { orgId: {} } },
        },
      },
    };
    expect(() => assertSchemaHasNoTenantKeys(schema, 't')).toThrow(/orgId/);
  });
});

describe('CopilotToolRegistry registration invariants', () => {
  it('accepts a clean tool', () => {
    const r = new CopilotToolRegistry();
    expect(() => r.registerTool(makeTool())).not.toThrow();
    expect(r.has('testTool')).toBe(true);
  });

  it('rejects duplicate registration', () => {
    const r = new CopilotToolRegistry();
    r.registerTool(makeTool({ name: 'one' }));
    expect(() => r.registerTool(makeTool({ name: 'one' }))).toThrow(/already registered/);
  });

  it('rejects a tool with a tenant-key in its schema (top-level)', () => {
    const r = new CopilotToolRegistry();
    expect(() =>
      r.registerTool(
        makeTool({
          parameters: {
            type: 'object',
            properties: { tenantId: { type: 'string' } },
          },
        }),
      ),
    ).toThrow(/tenantId/);
  });

  it('rejects a tool with a deep nested tenant-key', () => {
    const r = new CopilotToolRegistry();
    expect(() =>
      r.registerTool(
        makeTool({
          parameters: {
            type: 'object',
            properties: {
              wrapper: {
                type: 'object',
                properties: {
                  inner: {
                    type: 'object',
                    properties: { customer_id: {} },
                  },
                },
              },
            },
          },
        }),
      ),
    ).toThrow(/customer_id/);
  });

  it('rejects a tool that declares a resource-id-shaped arg in v1', () => {
    const r = new CopilotToolRegistry();
    expect(() =>
      r.registerTool(
        makeTool({
          parameters: {
            type: 'object',
            properties: { chatSessionId: { type: 'string' } },
          } as CopilotToolParameterSchema,
        }),
      ),
    ).toThrow(/resource-id/);
  });

  it('rejects parameters.type other than "object"', () => {
    const r = new CopilotToolRegistry();
    expect(() =>
      r.registerTool(
        makeTool({
          parameters: { type: 'string' as 'object', properties: {} },
        }),
      ),
    ).toThrow(/must be 'object'/);
  });
});

describe('buildV1CopilotToolRegistry — v1 lock-in', () => {
  it('registers exactly the V1_COPILOT_TOOL_NAMES whitelist', () => {
    const r = buildV1CopilotToolRegistry();
    const registered = r.getCopilotToolNames().sort();
    const expected = [...V1_COPILOT_TOOL_NAMES].sort();
    expect(registered).toEqual(expected);
  });

  it('every registered tool has parameters.type === "object" with empty properties', () => {
    // v1 tools take no args (round 3 #11). When v2 adds args, this assertion relaxes per tool.
    const r = buildV1CopilotToolRegistry();
    for (const tool of r.getCopilotTools()) {
      expect(tool.parameters.type).toBe('object');
      expect(Object.keys(tool.parameters.properties)).toEqual([]);
    }
  });

  it('every registered tool has a non-empty name + description', () => {
    const r = buildV1CopilotToolRegistry();
    for (const tool of r.getCopilotTools()) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(10);
    }
  });
});

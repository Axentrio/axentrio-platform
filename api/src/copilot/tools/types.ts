/**
 * Copilot tool surface — separate type hierarchy from the end-user
 * `agent/tool-registry.ts`.
 *
 * Two security invariants live HERE rather than in the agent loop:
 *
 *  1. `execute(args, ctx)` — `ctx.tenantId` is set by Clerk middleware
 *     server-side. Tools resolve scope from `ctx`, NEVER from `args`.
 *     This is enforced at registration time by the schema denylist
 *     (see `TENANT_KEY_DENYLIST` + `assertSchemaHasNoTenantKeys`).
 *
 *  2. v1 tools take NO resource-ID args. The registry asserts this at
 *     registration time (per round 3 #11). When v2 adds a tool that
 *     legitimately accepts a tenant-scoped row ID, that tool's
 *     implementation will run a tenant-scoped existence check before
 *     any read (invariant #4); v1 doesn't need that path.
 */
import type { CopilotReadOnlyManager } from '../manager/read-only-manager';

/**
 * Server-built context passed to every Copilot tool. `tenantId` and
 * `userId` are populated from the authenticated Clerk session via
 * `resolveTenantContext` middleware. Tools NEVER trust client-supplied
 * tenant selection.
 */
export interface CopilotToolContext {
  tenantId: string;
  userId: string;
  /**
   * Tenant-scoped, read-only data access. All tools use this — none
   * touch raw EntityManager / DataSource directly.
   */
  manager: CopilotReadOnlyManager;
}

/**
 * Minimal JSON-Schema fragment — enough to constrain Copilot tool
 * parameter shapes without depending on a full JSON Schema library.
 * Tools that take no args declare `{ type: 'object', properties: {} }`.
 */
export interface CopilotToolParameterSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface CopilotTool<Args = Record<string, never>, Result = unknown> {
  /** Stable identifier; matches what the LLM sees in tool-calling. */
  name: string;
  /** One-line description rendered into the system prompt. */
  description: string;
  /** JSON Schema for the args object. Validated by the denylist. */
  parameters: CopilotToolParameterSchema;
  /**
   * Execute the tool. `args` validated against `parameters` by the
   * caller before invocation. `ctx` is server-trusted.
   */
  execute(args: Args, ctx: CopilotToolContext): Promise<Result>;
}

/**
 * Case-insensitive keys forbidden anywhere in a tool's
 * `parameters` schema. Tools that try to declare any of these throw
 * at registration time. The check is recursive over `properties`,
 * `items`, `additionalProperties`, `$defs`, and `anyOf`/`oneOf`/`allOf`.
 *
 * Adding to this list is a security-sensitive change — these are
 * fields the client must NEVER influence.
 */
export const TENANT_KEY_DENYLIST: readonly string[] = [
  'tenantid',
  'tenant_id',
  'tenant',
  'orgid',
  'org_id',
  'organizationid',
  'organization_id',
  'clerkorgid',
  'clerk_org_id',
  'customerid',
  'customer_id',
] as const;

/**
 * Throw if any property key in the schema (case-insensitive,
 * recursive) matches the tenant-key denylist.
 *
 * Walks `properties`, `items` / `additionalProperties` shapes, plus
 * the `$defs` / `anyOf` / `oneOf` / `allOf` combinators. Non-object
 * nodes are skipped.
 */
export function assertSchemaHasNoTenantKeys(
  schema: unknown,
  toolName: string,
  path: string[] = [],
): void {
  if (schema === null || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;

  const properties = node.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, child] of Object.entries(properties)) {
      if (TENANT_KEY_DENYLIST.includes(key.toLowerCase())) {
        throw new Error(
          `Copilot tool '${toolName}' parameter schema includes forbidden tenant-binding key '${key}' at ${[...path, 'properties', key].join('.')}. ` +
            `Tenant context comes from ctx, never from args.`,
        );
      }
      assertSchemaHasNoTenantKeys(child, toolName, [...path, 'properties', key]);
    }
  }

  // patternProperties — keys are regex, so we can't lowercase-compare
  // them. We don't currently allow tenant patterns via this path; if a
  // tool needs patternProperties later we'll re-evaluate.
  const patternProperties = node.patternProperties;
  if (patternProperties && typeof patternProperties === 'object') {
    for (const [pat, child] of Object.entries(patternProperties)) {
      assertSchemaHasNoTenantKeys(child, toolName, [...path, 'patternProperties', pat]);
    }
  }

  const items = node.items;
  if (items && typeof items === 'object') {
    assertSchemaHasNoTenantKeys(items, toolName, [...path, 'items']);
  }

  const additionalProperties = node.additionalProperties;
  if (additionalProperties && typeof additionalProperties === 'object') {
    assertSchemaHasNoTenantKeys(additionalProperties, toolName, [...path, 'additionalProperties']);
  }

  const defs = (node.$defs ?? node.definitions) as Record<string, unknown> | undefined;
  if (defs && typeof defs === 'object') {
    for (const [k, child] of Object.entries(defs)) {
      assertSchemaHasNoTenantKeys(child, toolName, [...path, '$defs', k]);
    }
  }

  for (const combinator of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = node[combinator];
    if (Array.isArray(list)) {
      list.forEach((child, idx) =>
        assertSchemaHasNoTenantKeys(child, toolName, [...path, combinator, String(idx)]),
      );
    }
  }
}

/**
 * Throw if any property at the top level is a resource-id-shaped key.
 * v1 tools take NO resource ids (round 3 #11). When v2 adds tools that
 * accept e.g. `chatSessionId`, the implementation runs a tenant-scoped
 * existence check before any read (invariant #4); the registry will
 * allow such tools via an opt-in flag at that point.
 */
export function assertSchemaHasNoResourceIds(
  schema: CopilotToolParameterSchema,
  toolName: string,
): void {
  const properties = schema.properties ?? {};
  for (const key of Object.keys(properties)) {
    if (/(?:^|[_A-Z])(Id|_id)$/i.test(key) || key.toLowerCase().endsWith('id')) {
      throw new Error(
        `Copilot tool '${toolName}' parameter schema declares resource-id-shaped property '${key}'. ` +
          `v1 Copilot tools take no resource IDs (round 3 #11). If a v2 tool needs one, opt in via the registry's allowResourceIds flag and add a tenant-scoped existence check per security invariant #4.`,
      );
    }
  }
}

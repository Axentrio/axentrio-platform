/**
 * Template resolver — DB-backed contract tests (.scratch/plan-bot-templates.md,
 * Phase 1 step 10). Exercises the real availability SQL (availableToAll ∪ grant,
 * latest-published subquery) and the pin/fallback logic (T12/T21), plus the D2
 * billable precheck.
 */
import { describe, it, expect } from 'vitest';
import { AppDataSource } from '../../database/data-source';
import { BotTemplate } from '../../database/entities/BotTemplate';
import { BotTemplateVersion } from '../../database/entities/BotTemplateVersion';
import { TenantBotTemplate } from '../../database/entities/TenantBotTemplate';
import {
  listAvailableTemplates,
  resolveBoundTemplate,
  composeTemplateBodies,
  type ResolvedTemplate,
} from '../../templates/template-resolver';
import { createTestTenant } from '../helpers/factories';

const rt = (body: string, topics: string[] = []): ResolvedTemplate => ({
  templateId: 't', body, config: { guardrails: { topicsToAvoid: topics } }, resolvedVersion: 1,
  category: null, expectedModules: [], selectedSkillIds: null, skillProse: null, variables: null, pinnedButUnavailable: false, templateUnavailable: false,
});

describe('composeTemplateBodies (AND/OR stitching)', () => {
  it('returns a single body unchanged', () => {
    expect(composeTemplateBodies([rt('Just plumbing')], 'or')).toBe('Just plumbing');
  });
  it('OR mode frames specialities as independent + self-selected', () => {
    const out = composeTemplateBodies([rt('Plumbing'), rt('Electrical')], 'or');
    expect(out).toMatch(/INDEPENDENT/i);
    expect(out).toContain('Plumbing');
    expect(out).toContain('Electrical');
    expect(out).toContain('### Speciality 1');
    expect(out).toContain('### Speciality 2');
  });
  it('AND mode frames specialities as one combined offering', () => {
    const out = composeTemplateBodies([rt('Plumbing'), rt('Electrical')], 'and');
    expect(out).toMatch(/combined/i);
  });
  it('drops empty bodies (unavailable templates contribute nothing)', () => {
    expect(composeTemplateBodies([rt('Plumbing'), rt('')], 'or')).toBe('Plumbing');
  });
});

type VerSpec = { version: number; body: string; status?: 'draft' | 'published' | 'unpublished' };

async function makeTemplate(opts: {
  key: string;
  availableToAllTenants?: boolean;
  status?: 'active' | 'archived';
  versions?: VerSpec[];
}): Promise<BotTemplate> {
  const t = await AppDataSource.getRepository(BotTemplate).save({
    key: opts.key,
    displayName: opts.key,
    availableToAllTenants: opts.availableToAllTenants ?? false,
    status: opts.status ?? 'active',
  });
  for (const v of opts.versions ?? []) {
    await AppDataSource.getRepository(BotTemplateVersion).save({
      templateId: t.id,
      version: v.version,
      body: v.body,
      status: v.status ?? 'published',
    });
  }
  return t;
}

async function grant(tenantId: string, templateId: string): Promise<void> {
  await AppDataSource.getRepository(TenantBotTemplate).save({ tenantId, templateId });
}

describe('listAvailableTemplates', () => {
  it('includes a globally-available active template', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await makeTemplate({ key: 'global', availableToAllTenants: true, versions: [{ version: 1, body: 'x' }] });

    const avail = await listAvailableTemplates(tenant.id);
    expect(avail.map((t) => t.key)).toContain('global');
    expect(avail.find((t) => t.key === 'global')?.latestPublishedVersion).toBe(1);
  });

  it('includes a per-tenant granted template but hides it from other tenants', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    const other = await createTestTenant({ tier: 'pro' });
    const tmpl = await makeTemplate({ key: 'bespoke', versions: [{ version: 1, body: 'x' }] });
    await grant(tenant.id, tmpl.id);

    expect((await listAvailableTemplates(tenant.id)).map((t) => t.key)).toContain('bespoke');
    expect((await listAvailableTemplates(other.id)).map((t) => t.key)).not.toContain('bespoke');
  });

  it('excludes archived templates even when globally available', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await makeTemplate({ key: 'archived', availableToAllTenants: true, status: 'archived', versions: [{ version: 1, body: 'x' }] });
    expect((await listAvailableTemplates(tenant.id)).map((t) => t.key)).not.toContain('archived');
  });

  it('reports null latestPublishedVersion when only drafts exist', async () => {
    const tenant = await createTestTenant({ tier: 'pro' });
    await makeTemplate({ key: 'draft-only', availableToAllTenants: true, versions: [{ version: 1, body: 'x', status: 'draft' }] });
    const t = (await listAvailableTemplates(tenant.id)).find((x) => x.key === 'draft-only');
    expect(t?.latestPublishedVersion).toBeNull();
  });

  it('D2: free tier resolves to no available templates', async () => {
    const tenant = await createTestTenant({ tier: 'free' });
    await makeTemplate({ key: 'global', availableToAllTenants: true, versions: [{ version: 1, body: 'x' }] });
    expect(await listAvailableTemplates(tenant.id)).toEqual([]);
  });

  it('D2: suspended status resolves to no available templates', async () => {
    const tenant = await createTestTenant({ tier: 'pro', status: 'suspended' });
    await makeTemplate({ key: 'global', availableToAllTenants: true, versions: [{ version: 1, body: 'x' }] });
    expect(await listAvailableTemplates(tenant.id)).toEqual([]);
  });
});

describe('resolveBoundTemplate', () => {
  it('unbound bot → empty body, no flags', async () => {
    expect(await resolveBoundTemplate({ templateId: null, templateVersion: 'latest' })).toEqual({
      templateId: null,
      body: '',
      config: {},
      resolvedVersion: null,
      category: null,
      expectedModules: [],
      selectedSkillIds: null, skillProse: null, variables: null,
      pinnedButUnavailable: false,
      templateUnavailable: false,
    });
  });

  it('latest → newest published version body', async () => {
    const t = await makeTemplate({
      key: 'multi',
      versions: [
        { version: 1, body: 'v1' },
        { version: 2, body: 'v2' },
        { version: 3, body: 'v3-draft', status: 'draft' },
      ],
    });
    const r = await resolveBoundTemplate({ templateId: t.id, templateVersion: 'latest' });
    expect(r.body).toBe('v2');
    expect(r.resolvedVersion).toBe(2);
    expect(r.pinnedButUnavailable).toBe(false);
  });

  it('fixed pin to a published version → that exact body', async () => {
    const t = await makeTemplate({ key: 'pinme', versions: [{ version: 1, body: 'v1' }, { version: 2, body: 'v2' }] });
    const r = await resolveBoundTemplate({ templateId: t.id, templateVersion: '1' });
    expect(r.body).toBe('v1');
    expect(r.resolvedVersion).toBe(1);
    expect(r.pinnedButUnavailable).toBe(false);
  });

  it('fixed pin to a non-published version → falls back to latest, flagged', async () => {
    const t = await makeTemplate({
      key: 'pin-gone',
      versions: [{ version: 1, body: 'v1' }, { version: 2, body: 'v2-unpub', status: 'unpublished' }],
    });
    const r = await resolveBoundTemplate({ templateId: t.id, templateVersion: '2' });
    expect(r.body).toBe('v1');
    expect(r.resolvedVersion).toBe(1);
    expect(r.pinnedButUnavailable).toBe(true);
    expect(r.templateUnavailable).toBe(false);
  });

  it('template with no published versions → templateUnavailable, empty body', async () => {
    const t = await makeTemplate({ key: 'no-pub', versions: [{ version: 1, body: 'd', status: 'draft' }] });
    const r = await resolveBoundTemplate({ templateId: t.id, templateVersion: 'latest' });
    expect(r.body).toBe('');
    expect(r.templateUnavailable).toBe(true);
  });

  it('archived template → templateUnavailable (runtime backstop)', async () => {
    const t = await makeTemplate({ key: 'arch', status: 'archived', versions: [{ version: 1, body: 'v1' }] });
    const r = await resolveBoundTemplate({ templateId: t.id, templateVersion: 'latest' });
    expect(r.body).toBe('');
    expect(r.templateUnavailable).toBe(true);
  });

  it('missing template id (deleted) → templateUnavailable, never throws', async () => {
    const r = await resolveBoundTemplate({ templateId: '00000000-0000-0000-0000-000000000000', templateVersion: 'latest' });
    expect(r.templateUnavailable).toBe(true);
    expect(r.body).toBe('');
  });

  it('blank-base shape: a published empty-body version resolves to empty (no flags)', async () => {
    const t = await makeTemplate({ key: 'blank-base', availableToAllTenants: true, versions: [{ version: 1, body: '' }] });
    const r = await resolveBoundTemplate({ templateId: t.id, templateVersion: 'latest' });
    expect(r).toMatchObject({ body: '', resolvedVersion: 1, pinnedButUnavailable: false, templateUnavailable: false });
  });
});

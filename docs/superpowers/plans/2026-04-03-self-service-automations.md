# Self-Service & No-Code Automations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable tenants to self-configure skills, automations (email notifications), and onboarding — all via API endpoints. No frontend in this plan.

**Architecture:** API routes for skills CRUD, automations CRUD, onboarding status. Automation engine processes webhook events and sends emails via Resend. Smart defaults set on tenant auto-provision. All config stored in existing `tenant.settings` JSONB.

**Tech Stack:** TypeScript, Express, Vitest, Resend SDK, existing TypeORM + Tenant entity

**Specs:** `docs/superpowers/specs/2026-04-03-no-code-automations-design.md`, `docs/superpowers/specs/2026-04-03-multi-tenant-self-service-design.md`

---

## Task Dependency Graph

```
Task 1 (template renderer) ─→ Task 3 (email service) ─→ Task 4 (automation engine) ─→ Task 6 (wire into emitter)
Task 2 (skills routes)     ─  independent
Task 5 (automations routes)─  depends on Task 3 (for test endpoint)
Task 7 (onboarding status) ─  independent
Task 8 (smart defaults)    ─  independent
Task 9 (available-tools)   ─  independent
```

Tasks 1, 2, 7, 8, 9 can all run in parallel.

---

### Task 1: Template Renderer

**Files:**
- Create: `api/src/automations/template.ts`
- Test: `api/src/__tests__/unit/template.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/template.test.ts
import { describe, it, expect } from 'vitest';
import { renderTemplate, getAvailableVariables } from '../../automations/template';

describe('renderTemplate', () => {
  it('replaces simple variables', () => {
    const result = renderTemplate('Hi {name}, your email is {email}', { name: 'Sarah', email: 'sarah@test.com' });
    expect(result).toBe('Hi Sarah, your email is sarah@test.com');
  });

  it('leaves unmatched variables as-is', () => {
    const result = renderTemplate('Hi {name}, your {missing} value', { name: 'Sarah' });
    expect(result).toBe('Hi Sarah, your {missing} value');
  });

  it('handles empty variables object', () => {
    const result = renderTemplate('Hi {name}', {});
    expect(result).toBe('Hi {name}');
  });

  it('handles empty template', () => {
    const result = renderTemplate('', { name: 'Sarah' });
    expect(result).toBe('');
  });

  it('escapes HTML in variable values', () => {
    const result = renderTemplate('Hi {name}', { name: '<script>alert("xss")</script>' });
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });
});

describe('getAvailableVariables', () => {
  it('returns variables for appointment.booked', () => {
    const vars = getAvailableVariables('appointment.booked');
    expect(vars).toContain('name');
    expect(vars).toContain('date');
    expect(vars).toContain('time');
    expect(vars).toContain('tenantName');
  });

  it('returns variables for lead.created', () => {
    const vars = getAvailableVariables('lead.created');
    expect(vars).toContain('name');
    expect(vars).toContain('email');
  });

  it('returns variables for conversation.ended', () => {
    const vars = getAvailableVariables('conversation.ended');
    expect(vars).toContain('messageCount');
    expect(vars).toContain('duration');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/template.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// api/src/automations/template.ts

const VARIABLES_BY_EVENT: Record<string, string[]> = {
  'appointment.booked': ['name', 'email', 'date', 'time', 'bookingId', 'tenantName', 'botName', 'channel'],
  'lead.created': ['name', 'email', 'phone', 'tenantName', 'botName', 'channel'],
  'conversation.ended': ['messageCount', 'duration', 'tags', 'tenantName', 'botName', 'channel'],
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderTemplate(template: string, variables: Record<string, string>): string {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = variables[key];
    return value !== undefined ? escapeHtml(value) : match;
  });
}

export function getAvailableVariables(eventType: string): string[] {
  return VARIABLES_BY_EVENT[eventType] || [];
}

export function buildVariablesFromEvent(event: any, tenantName: string, botName: string): Record<string, string> {
  const base: Record<string, string> = {
    tenantName,
    botName,
    channel: event.session?.channel || 'widget',
  };

  if (event.type === 'appointment.booked' && event.appointment) {
    const dt = new Date(event.appointment.startTime);
    base.name = event.appointment.attendeeName || '';
    base.email = event.appointment.attendeeEmail || '';
    base.date = dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    base.time = dt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    base.bookingId = event.appointment.bookingId || '';
  }

  if (event.type === 'lead.created' && event.lead) {
    base.name = event.lead.name || '';
    base.email = event.lead.email || '';
    base.phone = event.lead.phone || '';
  }

  if (event.type === 'conversation.ended' && event.conversation) {
    base.messageCount = String(event.conversation.messageCount || 0);
    base.duration = String(Math.round((event.conversation.durationSeconds || 0) / 60));
    base.tags = (event.session?.tags || []).join(', ');
  }

  return base;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/template.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/automations/template.ts src/__tests__/unit/template.test.ts
git commit -m "feat: add template renderer for automation emails"
```

---

### Task 2: Skills CRUD API

**Files:**
- Create: `api/src/routes/skills.routes.ts`
- Test: `api/src/__tests__/unit/skills-routes.test.ts`
- Modify: `api/src/server.ts` — mount routes

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/skills-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
const mockFindOne = vi.fn();
const mockSave = vi.fn();
vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: vi.fn().mockReturnValue({ findOne: mockFindOne, save: mockSave }),
  },
}));

vi.mock('../../agent/tool-registry', () => ({
  ToolRegistry: class { getBuiltinToolNames() { return ['kb_search', 'check_availability', 'create_booking', 'capture_lead', 'escalate_to_human']; } },
}));

import { validateSkill, validateToolNames } from '../../routes/skills.routes';

describe('Skills validation', () => {
  it('validates a correct skill', () => {
    const result = validateSkill({
      name: 'booking',
      trigger: 'User wants to schedule',
      tools: ['check_availability', 'create_booking'],
      instructions: 'Check availability first.',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects skill with empty name', () => {
    const result = validateSkill({ name: '', trigger: 'test', tools: ['kb_search'], instructions: 'test' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('name');
  });

  it('rejects skill with invalid characters in name', () => {
    const result = validateSkill({ name: 'my skill!', trigger: 'test', tools: ['kb_search'], instructions: 'test' });
    expect(result.valid).toBe(false);
  });

  it('rejects skill with too-long instructions', () => {
    const result = validateSkill({ name: 'test', trigger: 'test', tools: ['kb_search'], instructions: 'x'.repeat(2001) });
    expect(result.valid).toBe(false);
  });

  it('validates tool names against registry', () => {
    const valid = validateToolNames(['kb_search', 'check_availability']);
    expect(valid.valid).toBe(true);

    const invalid = validateToolNames(['kb_search', 'nonexistent_tool']);
    expect(invalid.valid).toBe(false);
    expect(invalid.invalidTools).toContain('nonexistent_tool');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/skills-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// api/src/routes/skills.routes.ts
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware';
import { ToolRegistry } from '../agent/tool-registry';
import { logger } from '../utils/logger';

const router = Router();
const toolRegistry = new ToolRegistry();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

interface SkillInput {
  name: string;
  trigger: string;
  tools: string[];
  instructions: string;
  maxSteps?: number;
  enabled?: boolean;
}

interface Skill extends SkillInput {
  maxSteps: number;
  enabled: boolean;
}

const NAME_REGEX = /^[a-zA-Z0-9_]{1,50}$/;
const MAX_SKILLS = 20;

export function validateSkill(input: Partial<SkillInput>): { valid: boolean; error?: string } {
  if (!input.name || !NAME_REGEX.test(input.name)) {
    return { valid: false, error: 'name must be 1-50 alphanumeric characters or underscores' };
  }
  if (!input.trigger || input.trigger.length > 500) {
    return { valid: false, error: 'trigger is required (max 500 chars)' };
  }
  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    return { valid: false, error: 'tools must be a non-empty array' };
  }
  if (!input.instructions || input.instructions.length > 2000) {
    return { valid: false, error: 'instructions is required (max 2000 chars)' };
  }
  if (input.maxSteps !== undefined && (input.maxSteps < 1 || input.maxSteps > 20)) {
    return { valid: false, error: 'maxSteps must be 1-20' };
  }
  return { valid: true };
}

export function validateToolNames(tools: string[]): { valid: boolean; invalidTools?: string[] } {
  const known = toolRegistry.getBuiltinToolNames();
  const invalid = tools.filter((t) => !known.includes(t));
  return invalid.length > 0 ? { valid: false, invalidTools: invalid } : { valid: true };
}

// GET /api/v1/tenants/me/skills
router.get('/me/skills', requireRole('admin', 'supervisor'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant) throw new NotFoundError('Tenant not found');

  const skills: Skill[] = (tenant.settings as any)?.skills || [];
  res.json({ success: true, data: { skills } });
}));

// POST /api/v1/tenants/me/skills
router.post('/me/skills', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: tenantId } });
  if (!tenant) throw new NotFoundError('Tenant not found');

  const validation = validateSkill(req.body);
  if (!validation.valid) throw new ValidationError(validation.error!);

  const toolValidation = validateToolNames(req.body.tools);
  if (!toolValidation.valid) throw new ValidationError(`Unknown tools: ${toolValidation.invalidTools!.join(', ')}`);

  const skills: Skill[] = (tenant.settings as any)?.skills || [];
  if (skills.length >= MAX_SKILLS) throw new ValidationError(`Maximum ${MAX_SKILLS} skills allowed`);
  if (skills.some((s) => s.name === req.body.name)) throw new ValidationError(`Skill "${req.body.name}" already exists`);

  const skill: Skill = {
    name: req.body.name,
    trigger: req.body.trigger,
    tools: req.body.tools,
    instructions: req.body.instructions,
    maxSteps: req.body.maxSteps || 5,
    enabled: req.body.enabled !== false,
  };

  skills.push(skill);
  tenant.settings = { ...tenant.settings, skills } as any;
  await repo.save(tenant);

  res.status(201).json({ success: true, data: { skill } });
}));

// PUT /api/v1/tenants/me/skills/:name
router.put('/me/skills/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { name } = req.params;
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: tenantId } });
  if (!tenant) throw new NotFoundError('Tenant not found');

  const skills: Skill[] = (tenant.settings as any)?.skills || [];
  const index = skills.findIndex((s) => s.name === name);
  if (index === -1) throw new NotFoundError(`Skill "${name}" not found`);

  // Partial update
  const updated = { ...skills[index], ...req.body, name }; // name cannot be changed
  if (req.body.tools) {
    const toolValidation = validateToolNames(req.body.tools);
    if (!toolValidation.valid) throw new ValidationError(`Unknown tools: ${toolValidation.invalidTools!.join(', ')}`);
  }

  skills[index] = updated;
  tenant.settings = { ...tenant.settings, skills } as any;
  await repo.save(tenant);

  res.json({ success: true, data: { skill: updated } });
}));

// DELETE /api/v1/tenants/me/skills/:name
router.delete('/me/skills/:name', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { name } = req.params;
  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: tenantId } });
  if (!tenant) throw new NotFoundError('Tenant not found');

  const skills: Skill[] = (tenant.settings as any)?.skills || [];
  const filtered = skills.filter((s) => s.name !== name);
  if (filtered.length === skills.length) throw new NotFoundError(`Skill "${name}" not found`);

  tenant.settings = { ...tenant.settings, skills: filtered } as any;
  await repo.save(tenant);

  res.json({ success: true });
}));

export default router;
```

- [ ] **Step 4: Mount in server.ts**

Add to imports in `server.ts`:
```typescript
import skillsRoutes from './routes/skills.routes';
```

Add after existing tenant routes mount:
```typescript
apiRouter.use('/tenants', skillsRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/skills-routes.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/skills.routes.ts src/__tests__/unit/skills-routes.test.ts src/server.ts
git commit -m "feat: add skills CRUD API endpoints"
```

---

### Task 3: Email Service (Resend)

**Files:**
- Create: `api/src/automations/email.service.ts`
- Test: `api/src/__tests__/unit/email-service.test.ts`
- Modify: `api/src/config/environment.ts` — add RESEND_API_KEY

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/email-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: mockSend };
  },
}));

import { EmailService } from '../../automations/email.service';

describe('EmailService', () => {
  let service: EmailService;

  beforeEach(() => {
    service = new EmailService('re_test_key', 'noreply@notifications.example.com');
    vi.clearAllMocks();
  });

  it('sends an email via Resend', async () => {
    mockSend.mockResolvedValue({ data: { id: 'msg_123' }, error: null });

    const result = await service.send({
      to: 'user@test.com',
      subject: 'Test',
      body: 'Hello!',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('msg_123');
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: ['user@test.com'],
      subject: 'Test',
      html: 'Hello!',
      from: 'noreply@notifications.example.com',
    }));
  });

  it('handles Resend errors gracefully', async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: 'Invalid API key' } });

    const result = await service.send({
      to: 'user@test.com',
      subject: 'Test',
      body: 'Hello!',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid API key');
  });

  it('sends to multiple recipients', async () => {
    mockSend.mockResolvedValue({ data: { id: 'msg_456' }, error: null });

    await service.send({
      to: ['a@test.com', 'b@test.com'],
      subject: 'Team Alert',
      body: 'New lead!',
    });

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: ['a@test.com', 'b@test.com'],
    }));
  });

  it('skips sending when no API key configured', async () => {
    const noKeyService = new EmailService('', 'noreply@test.com');
    const result = await noKeyService.send({ to: 'test@test.com', subject: 'Test', body: 'Hi' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
    expect(mockSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/email-service.test.ts`
Expected: FAIL

- [ ] **Step 3: Install Resend SDK**

```bash
cd chatbot-platform/api && npm install resend
```

- [ ] **Step 4: Write the implementation**

```typescript
// api/src/automations/email.service.ts
import { Resend } from 'resend';
import { logger } from '../utils/logger';

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
  replyTo?: string;
}

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export class EmailService {
  private resend: Resend | null;
  private defaultFrom: string;

  constructor(apiKey: string, defaultFrom: string) {
    this.resend = apiKey ? new Resend(apiKey) : null;
    this.defaultFrom = defaultFrom;
  }

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    if (!this.resend) {
      return { success: false, error: 'Email service not configured — RESEND_API_KEY missing' };
    }

    try {
      const to = Array.isArray(params.to) ? params.to : [params.to];

      const { data, error } = await this.resend.emails.send({
        from: params.from || this.defaultFrom,
        to,
        subject: params.subject,
        html: params.body,
        reply_to: params.replyTo,
      });

      if (error) {
        logger.warn('Email send failed', { error: error.message, to });
        return { success: false, error: error.message };
      }

      logger.info('Email sent', { messageId: data?.id, to });
      return { success: true, messageId: data?.id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown email error';
      logger.error('Email send exception', { error: msg });
      return { success: false, error: msg };
    }
  }
}
```

- [ ] **Step 5: Add env var to config**

In `api/src/config/environment.ts`, add to the schema:
```typescript
RESEND_API_KEY: z.string().optional(),
EMAIL_FROM_ADDRESS: z.string().default('noreply@notifications.example.com'),
```

Add to the config export:
```typescript
email: {
  resendApiKey: env.RESEND_API_KEY,
  fromAddress: env.EMAIL_FROM_ADDRESS,
},
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/email-service.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/automations/email.service.ts src/__tests__/unit/email-service.test.ts src/config/environment.ts package.json package-lock.json
git commit -m "feat: add email service with Resend SDK"
```

---

### Task 4: Automation Engine

**Files:**
- Create: `api/src/automations/automation.engine.ts`
- Test: `api/src/__tests__/unit/automation-engine.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/automation-engine.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationEngine } from '../../automations/automation.engine';
import type { EmailService } from '../../automations/email.service';
import type { AppointmentBookedEvent, LeadCreatedEvent, ConversationEndedEvent } from '../../webhooks/webhook.types';

const mockSend = vi.fn().mockResolvedValue({ success: true, messageId: 'msg_1' });
const mockEmailService: EmailService = { send: mockSend } as any;

describe('AutomationEngine', () => {
  let engine: AutomationEngine;

  beforeEach(() => {
    engine = new AutomationEngine(mockEmailService);
    vi.clearAllMocks();
  });

  it('sends booking confirmation when enabled', async () => {
    const tenant = {
      name: 'Test Clinic',
      settings: {
        ai: { brandVoice: { name: 'TestBot' } },
        automations: {
          emailNotifications: {
            bookingConfirmation: {
              enabled: true,
              subject: 'Confirmed — {tenantName}',
              body: 'Hi {name}, your appointment is on {date} at {time}.',
            },
          },
        },
      },
    };

    const event: AppointmentBookedEvent = {
      id: 'evt_1', type: 'appointment.booked', tenantId: 't1', sessionId: 's1',
      timestamp: new Date().toISOString(),
      session: { channel: 'widget', visitorId: 'v1', startedAt: new Date().toISOString(), messageCount: 5 },
      appointment: { bookingId: 'bk_1', startTime: '2026-04-07T10:00:00+02:00', attendeeName: 'Sarah', attendeeEmail: 'sarah@test.com' },
    };

    await engine.process(event, tenant as any);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: 'sarah@test.com',
      subject: expect.stringContaining('Test Clinic'),
    }));
  });

  it('sends new lead alert to team recipients', async () => {
    const tenant = {
      name: 'Agency',
      settings: {
        ai: { brandVoice: { name: 'Bot' } },
        automations: {
          emailNotifications: {
            newLeadAlert: {
              enabled: true,
              recipients: ['team@agency.com', 'boss@agency.com'],
              subject: 'New Lead: {name}',
              body: 'Lead captured: {name} ({email})',
            },
          },
        },
      },
    };

    const event: LeadCreatedEvent = {
      id: 'evt_2', type: 'lead.created', tenantId: 't1', sessionId: 's1',
      timestamp: new Date().toISOString(),
      session: { channel: 'widget', visitorId: 'v1', startedAt: new Date().toISOString(), messageCount: 3 },
      lead: { name: 'John', email: 'john@test.com', source: 'chat' },
    };

    await engine.process(event, tenant as any);

    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({
      to: ['team@agency.com', 'boss@agency.com'],
      subject: 'New Lead: John',
    }));
  });

  it('does nothing when automations not configured', async () => {
    const tenant = { name: 'Empty', settings: {} };
    const event: LeadCreatedEvent = {
      id: 'evt_3', type: 'lead.created', tenantId: 't1', sessionId: 's1',
      timestamp: new Date().toISOString(),
      session: { channel: 'widget', visitorId: 'v1', startedAt: new Date().toISOString(), messageCount: 1 },
      lead: { name: 'Test', email: 'test@test.com', source: 'tool' },
    };

    await engine.process(event, tenant as any);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does nothing when automation is disabled', async () => {
    const tenant = {
      name: 'Disabled',
      settings: {
        automations: {
          emailNotifications: {
            bookingConfirmation: { enabled: false, subject: 'Test', body: 'Test' },
          },
        },
      },
    };

    const event: AppointmentBookedEvent = {
      id: 'evt_4', type: 'appointment.booked', tenantId: 't1', sessionId: 's1',
      timestamp: new Date().toISOString(),
      session: { channel: 'widget', visitorId: 'v1', startedAt: new Date().toISOString(), messageCount: 2 },
      appointment: { bookingId: 'bk_2', startTime: '2026-04-07T10:00:00', attendeeName: 'X', attendeeEmail: 'x@test.com' },
    };

    await engine.process(event, tenant as any);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/automation-engine.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// api/src/automations/automation.engine.ts
import { Tenant } from '../database/entities/Tenant';
import { EmailService } from './email.service';
import { renderTemplate, buildVariablesFromEvent } from './template';
import { logger } from '../utils/logger';
import type { WebhookEvent, AppointmentBookedEvent, LeadCreatedEvent, ConversationEndedEvent } from '../webhooks/webhook.types';

export class AutomationEngine {
  constructor(private emailService: EmailService) {}

  async process(event: WebhookEvent, tenant: Tenant): Promise<void> {
    const automations = (tenant.settings as any)?.automations;
    if (!automations?.emailNotifications) return;

    const notifications = automations.emailNotifications;
    const tenantName = tenant.name;
    const botName = (tenant.settings as any)?.ai?.brandVoice?.name || tenant.name;
    const variables = buildVariablesFromEvent(event, tenantName, botName);

    try {
      switch (event.type) {
        case 'appointment.booked':
          if (notifications.bookingConfirmation?.enabled) {
            const cfg = notifications.bookingConfirmation;
            await this.emailService.send({
              to: (event as AppointmentBookedEvent).appointment.attendeeEmail,
              subject: renderTemplate(cfg.subject || 'Appointment Confirmed', variables),
              body: renderTemplate(cfg.body || 'Your appointment is confirmed.', variables),
            });
          }
          break;

        case 'lead.created':
          if (notifications.newLeadAlert?.enabled && notifications.newLeadAlert.recipients?.length) {
            const cfg = notifications.newLeadAlert;
            await this.emailService.send({
              to: cfg.recipients,
              subject: renderTemplate(cfg.subject || 'New Lead: {name}', variables),
              body: renderTemplate(cfg.body || 'New lead captured: {name} ({email})', variables),
            });
          }
          break;

        case 'conversation.ended':
          if (notifications.conversationSummary?.enabled && notifications.conversationSummary.recipients?.length) {
            const cfg = notifications.conversationSummary;
            await this.emailService.send({
              to: cfg.recipients,
              subject: renderTemplate(cfg.subject || 'Conversation Summary', variables),
              body: renderTemplate(cfg.body || 'Chat ended: {messageCount} messages, {duration} min.', variables),
            });
          }
          // Note: followUp with delay is Phase 2 (needs a job queue)
          break;
      }
    } catch (err) {
      logger.error('AutomationEngine.process failed', {
        eventType: event.type,
        tenantId: event.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/automation-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/automations/automation.engine.ts src/__tests__/unit/automation-engine.test.ts
git commit -m "feat: add automation engine for email notifications"
```

---

### Task 5: Automations CRUD API

**Files:**
- Create: `api/src/routes/automations.routes.ts`
- Test: `api/src/__tests__/unit/automations-routes.test.ts`
- Modify: `api/src/server.ts` — mount routes

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/automations-routes.test.ts
import { describe, it, expect } from 'vitest';
import { validateAutomationUpdate } from '../../routes/automations.routes';

describe('Automations validation', () => {
  it('validates bookingConfirmation update', () => {
    const result = validateAutomationUpdate('bookingConfirmation', {
      enabled: true,
      subject: 'Confirmed — {tenantName}',
      body: 'Hi {name}, booked for {date}.',
    });
    expect(result.valid).toBe(true);
  });

  it('validates newLeadAlert with recipients', () => {
    const result = validateAutomationUpdate('newLeadAlert', {
      enabled: true,
      recipients: ['team@agency.com'],
    });
    expect(result.valid).toBe(true);
  });

  it('rejects newLeadAlert without recipients when enabled', () => {
    const result = validateAutomationUpdate('newLeadAlert', {
      enabled: true,
      recipients: [],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects unknown automation type', () => {
    const result = validateAutomationUpdate('unknownType', { enabled: true });
    expect(result.valid).toBe(false);
  });

  it('rejects subject over 200 chars', () => {
    const result = validateAutomationUpdate('bookingConfirmation', {
      enabled: true,
      subject: 'x'.repeat(201),
    });
    expect(result.valid).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/automations-routes.test.ts`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

```typescript
// api/src/routes/automations.routes.ts
import { Router, Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { requireRole } from '../middleware/auth.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware';
import { logger } from '../utils/logger';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

const VALID_TYPES = ['bookingConfirmation', 'newLeadAlert', 'conversationSummary', 'followUp'];
const TYPES_REQUIRING_RECIPIENTS = ['newLeadAlert', 'conversationSummary'];

export function validateAutomationUpdate(
  type: string,
  body: Record<string, any>
): { valid: boolean; error?: string } {
  if (!VALID_TYPES.includes(type)) {
    return { valid: false, error: `Unknown automation type: ${type}. Valid: ${VALID_TYPES.join(', ')}` };
  }
  if (body.subject && body.subject.length > 200) {
    return { valid: false, error: 'subject must be under 200 characters' };
  }
  if (body.body && body.body.length > 5000) {
    return { valid: false, error: 'body must be under 5000 characters' };
  }
  if (body.enabled && TYPES_REQUIRING_RECIPIENTS.includes(type)) {
    if (!body.recipients || !Array.isArray(body.recipients) || body.recipients.length === 0) {
      return { valid: false, error: `${type} requires at least one recipient email when enabled` };
    }
  }
  if (body.delayHours !== undefined && (body.delayHours < 1 || body.delayHours > 168)) {
    return { valid: false, error: 'delayHours must be 1-168' };
  }
  return { valid: true };
}

// GET /api/v1/tenants/me/automations
router.get('/me/automations', requireRole('admin', 'supervisor'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant) throw new NotFoundError('Tenant not found');

  const automations = (tenant.settings as any)?.automations || {
    emailNotifications: {},
    customWebhooks: [],
  };

  res.json({ success: true, data: { automations } });
}));

// PATCH /api/v1/tenants/me/automations/email/:type
router.patch('/me/automations/email/:type', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { type } = req.params;

  const validation = validateAutomationUpdate(type, req.body);
  if (!validation.valid) throw new ValidationError(validation.error!);

  const repo = AppDataSource.getRepository(Tenant);
  const tenant = await repo.findOne({ where: { id: tenantId } });
  if (!tenant) throw new NotFoundError('Tenant not found');

  const settings = tenant.settings as any || {};
  if (!settings.automations) settings.automations = {};
  if (!settings.automations.emailNotifications) settings.automations.emailNotifications = {};

  settings.automations.emailNotifications[type] = {
    ...settings.automations.emailNotifications[type],
    ...req.body,
  };

  tenant.settings = settings;
  await repo.save(tenant);

  res.json({ success: true, data: { automation: settings.automations.emailNotifications[type] } });
}));

// POST /api/v1/tenants/me/automations/email/:type/test
router.post('/me/automations/email/:type/test', requireRole('admin'), asyncHandler(async (req: Request, res: Response) => {
  const tenantId = req.user!.tenantId;
  const { type } = req.params;

  if (!VALID_TYPES.includes(type)) throw new ValidationError(`Unknown type: ${type}`);

  const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
  if (!tenant) throw new NotFoundError('Tenant not found');

  const testEmail = req.body.email || req.user!.email;
  if (!testEmail) throw new ValidationError('email is required for test');

  // Import email service lazily to avoid circular deps
  const { getEmailService } = await import('../automations/index');
  const emailService = getEmailService();

  const result = await emailService.send({
    to: testEmail,
    subject: `[TEST] Automation test — ${type}`,
    body: `This is a test email for the "${type}" automation from ${tenant.name}. If you received this, the email integration is working correctly.`,
  });

  res.json({ success: result.success, data: result });
}));

export default router;
```

- [ ] **Step 4: Mount in server.ts**

Add import and mount alongside skills routes:
```typescript
import automationsRoutes from './routes/automations.routes';
// ...
apiRouter.use('/tenants', automationsRoutes);
```

- [ ] **Step 5: Run test**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/automations-routes.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/routes/automations.routes.ts src/__tests__/unit/automations-routes.test.ts src/server.ts
git commit -m "feat: add automations CRUD API with email test endpoint"
```

---

### Task 6: Wire Automation Engine into Webhook Emitter

**Files:**
- Create: `api/src/automations/index.ts` — module init + exports
- Modify: `api/src/webhooks/webhook.emitter.ts` — call automation engine
- Modify: `api/src/server.ts` — initialize email service + automation engine

- [ ] **Step 1: Create automations module index**

```typescript
// api/src/automations/index.ts
import { EmailService } from './email.service';
import { AutomationEngine } from './automation.engine';
import { config } from '../config/environment';

let emailService: EmailService | null = null;
let automationEngine: AutomationEngine | null = null;

export function initializeAutomations(): void {
  const apiKey = (config as any).email?.resendApiKey || '';
  const fromAddress = (config as any).email?.fromAddress || 'noreply@notifications.example.com';
  emailService = new EmailService(apiKey, fromAddress);
  automationEngine = new AutomationEngine(emailService);
}

export function getAutomationEngine(): AutomationEngine | null {
  return automationEngine;
}

export function getEmailService(): EmailService {
  if (!emailService) {
    throw new Error('Email service not initialized. Call initializeAutomations() first.');
  }
  return emailService;
}
```

- [ ] **Step 2: Modify webhook emitter to call automation engine**

In `api/src/webhooks/webhook.emitter.ts`, add after the webhook dispatch:

```typescript
import { getAutomationEngine } from '../automations';

// Inside emitWebhookEvent(), after the Promise.allSettled for webhooks:
const engine = getAutomationEngine();
if (engine && tenant) {
  engine.process(event, tenant).catch((err) =>
    logger.error('Automation engine error', { eventId: event.id, error: err })
  );
}
```

- [ ] **Step 3: Initialize in server.ts**

In `server.ts`, after the platform agent initialization block:

```typescript
// Initialize automations (email service + engine)
try {
  const { initializeAutomations } = await import('./automations');
  initializeAutomations();
  logger.info('Automation engine initialized');
} catch (err) {
  logger.warn('Automation engine initialization failed', { error: err });
}
```

- [ ] **Step 4: Run all tests**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts --reporter=verbose`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/automations/index.ts src/webhooks/webhook.emitter.ts src/server.ts
git commit -m "feat: wire automation engine into webhook event pipeline"
```

---

### Task 7: Onboarding Status Endpoint

**Files:**
- Modify: `api/src/routes/tenants.ts` — add endpoint
- Test: `api/src/__tests__/unit/onboarding-status.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// api/src/__tests__/unit/onboarding-status.test.ts
import { describe, it, expect } from 'vitest';
import { computeOnboardingStatus } from '../../routes/tenants';

describe('computeOnboardingStatus', () => {
  it('returns all false for empty tenant', () => {
    const result = computeOnboardingStatus({ settings: {} } as any, 0);
    expect(result.complete).toBe(false);
    expect(result.completedCount).toBe(0);
    expect(result.steps.aiEnabled).toBe(false);
  });

  it('detects AI enabled', () => {
    const result = computeOnboardingStatus({
      settings: { ai: { enabled: true, usePlatformAgent: true } },
    } as any, 0);
    expect(result.steps.aiEnabled).toBe(true);
    expect(result.completedCount).toBe(1);
  });

  it('detects brand voice configured', () => {
    const result = computeOnboardingStatus({
      settings: { ai: { enabled: true, usePlatformAgent: true, brandVoice: { name: 'MyBot' } } },
    } as any, 0);
    expect(result.steps.brandVoiceConfigured).toBe(true);
  });

  it('detects KB docs', () => {
    const result = computeOnboardingStatus({ settings: {} } as any, 5);
    expect(result.steps.knowledgeBaseHasDocs).toBe(true);
  });

  it('detects calcom connected', () => {
    const result = computeOnboardingStatus({
      settings: { integrations: { calcom: { apiKey: 'encrypted_value_here', eventTypeId: 42 } } },
    } as any, 0);
    expect(result.steps.calcomConnected).toBe(true);
  });

  it('returns complete when all steps done', () => {
    const result = computeOnboardingStatus({
      settings: {
        ai: { enabled: true, usePlatformAgent: true, brandVoice: { name: 'Bot' } },
        integrations: { calcom: { apiKey: 'enc', eventTypeId: 1 } },
        automations: { emailNotifications: { newLeadAlert: { enabled: true } } },
      },
    } as any, 3);
    expect(result.complete).toBe(true);
    expect(result.completedCount).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/onboarding-status.test.ts`
Expected: FAIL

- [ ] **Step 3: Add to tenants.ts**

Export the computation function and add the route:

```typescript
// Add to api/src/routes/tenants.ts

export function computeOnboardingStatus(tenant: any, kbDocCount: number) {
  const settings = tenant.settings || {};
  const ai = settings.ai || {};
  const integrations = settings.integrations || {};
  const automations = settings.automations || {};

  const steps = {
    aiEnabled: !!(ai.enabled && ai.usePlatformAgent),
    brandVoiceConfigured: !!(ai.brandVoice?.name && ai.brandVoice.name !== 'Organization Assistant'),
    knowledgeBaseHasDocs: kbDocCount > 0,
    calcomConnected: !!(integrations.calcom?.apiKey && integrations.calcom?.eventTypeId),
    automationsConfigured: !!(
      automations.emailNotifications?.bookingConfirmation?.enabled ||
      automations.emailNotifications?.newLeadAlert?.enabled ||
      automations.emailNotifications?.conversationSummary?.enabled
    ),
  };

  const completedCount = Object.values(steps).filter(Boolean).length;

  return {
    complete: completedCount === 5,
    completedCount,
    totalCount: 5,
    steps,
  };
}

// GET /api/v1/tenants/me/onboarding-status
router.get(
  '/me/onboarding-status',
  requireClerkAuth, autoProvision,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const kbResult = await AppDataSource.query(
      `SELECT COUNT(*)::int AS count FROM knowledge_documents WHERE "tenantId" = $1 AND status = 'indexed'`,
      [tenantId]
    ).catch(() => [{ count: 0 }]);

    const status = computeOnboardingStatus(tenant, kbResult[0]?.count || 0);
    res.json({ success: true, data: status });
  })
);
```

- [ ] **Step 4: Run test**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/onboarding-status.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes/tenants.ts src/__tests__/unit/onboarding-status.test.ts
git commit -m "feat: add onboarding status endpoint"
```

---

### Task 8: Smart Defaults on Auto-Provision

**Files:**
- Modify: `api/src/middleware/clerk.middleware.ts`

- [ ] **Step 1: Find the tenant creation block in autoProvision**

In `clerk.middleware.ts`, around line 124-137, where the tenant is inserted via `createQueryBuilder().insert()`.

- [ ] **Step 2: Add smart defaults to the insert values**

Update the `.values({...})` to include default settings:

```typescript
.values({
  name: orgName,
  slug,
  apiKey,
  clerkOrgId,
  tier: 'pro',
  status: 'active',
  settings: {
    ai: {
      enabled: true,
      usePlatformAgent: true,
      provider: 'openai',
      model: 'gpt-4o-mini',
      brandVoice: {
        name: `${orgName} Assistant`,
        tone: 'friendly',
        customInstructions: '',
      },
      guardrails: {
        topicsToAvoid: [],
        escalationKeywords: ['speak to someone', 'human agent', 'talk to a person'],
        confidenceThreshold: 0.7,
        maxResponseLength: 500,
        greetingMessage: `Welcome! How can I help you today?`,
        fallbackMessage: `Let me connect you with our team.`,
        offHoursMessage: `We're currently outside business hours. We'll get back to you soon.`,
      },
    },
  },
})
```

- [ ] **Step 3: Run full test suite to verify no regressions**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts`
Expected: All pass (smart defaults only affect new tenant creation, no existing tests break)

- [ ] **Step 4: Commit**

```bash
git add src/middleware/clerk.middleware.ts
git commit -m "feat: add smart defaults on tenant auto-provision"
```

---

### Task 9: Available Tools Endpoint

**Files:**
- Modify: `api/src/routes/tenants.ts` — add endpoint

- [ ] **Step 1: Add the endpoint**

```typescript
// Add to api/src/routes/tenants.ts

// GET /api/v1/tenants/me/available-tools
router.get(
  '/me/available-tools',
  requireClerkAuth, autoProvision,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.user!.tenantId;
    const tenant = await AppDataSource.getRepository(Tenant).findOne({ where: { id: tenantId } });
    if (!tenant) throw new NotFoundError('Tenant not found');

    const { ToolRegistry } = await import('../agent/tool-registry');
    const registry = new ToolRegistry();
    const tools = await registry.getToolsForTenant(tenant);

    res.json({
      success: true,
      data: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          hasSideEffects: t.hasSideEffects,
          category: ['kb_search', 'capture_lead', 'escalate_to_human'].includes(t.name) ? 'always' : 'booking',
        })),
      },
    });
  })
);
```

- [ ] **Step 2: Run all tests**

Run: `cd chatbot-platform/api && npx vitest run --config vitest.unit.config.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/routes/tenants.ts
git commit -m "feat: add available-tools endpoint for tenant"
```

---

## Summary

| Task | What It Builds | Dependencies |
|------|---------------|-------------|
| 1 | Template renderer (variable interpolation + XSS escape) | None |
| 2 | Skills CRUD API (list, create, update, delete) | None |
| 3 | Email service (Resend SDK wrapper) | None |
| 4 | Automation engine (event → check config → send email) | Tasks 1, 3 |
| 5 | Automations CRUD API (get, update, test) | Task 3 |
| 6 | Wire engine into webhook emitter + server init | Task 4 |
| 7 | Onboarding status endpoint | None |
| 8 | Smart defaults on auto-provision | None |
| 9 | Available tools endpoint | None |

**Parallel groups:** Tasks 1, 2, 3, 7, 8, 9 can all run in parallel. Then 4 + 5 (need 1 + 3). Then 6 (needs 4).

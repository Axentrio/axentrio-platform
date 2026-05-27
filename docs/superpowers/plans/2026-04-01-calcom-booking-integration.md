# Cal.com Booking Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cal.com booking capabilities (check availability, create, reschedule, cancel) to the chatbot platform via internal proxy endpoints that n8n's AI Agent calls as tools.

**Architecture:** Platform acts as a secure proxy between n8n and Cal.com. n8n never sees Cal.com credentials — the platform decrypts them per-tenant, calls Cal.com, returns results. Tenant derived from `sessionId` server-side. Follows the existing RAG search endpoint pattern.

**Tech Stack:** Express, TypeORM, Zod, axios (Cal.com HTTP client), n8n (workflow JSON)

**Spec:** `docs/superpowers/specs/2026-04-01-calcom-booking-integration-design.md`

---

## File Structure

### New files:
- `api/src/database/entities/BookingLog.ts` — TypeORM entity for booking_logs table
- `api/src/database/migrations/1780000000000-CreateBookingLogs.ts` — Migration
- `api/src/schemas/integrations.schema.ts` — Zod validation for integrations config
- `api/src/knowledge/integrations.controller.ts` — Controller for integrations CRUD (encrypt/redact)
- `api/src/knowledge/integrations.routes.ts` — Routes for integrations config
- `api/src/n8n/booking.service.ts` — Cal.com API client + business logic
- `api/src/n8n/booking.routes.ts` — 5 internal booking endpoints

### Modified files:
- `api/src/n8n/types/message.types.ts` — Add `IntegrationsConfig` to `OutboundMessage`
- `api/src/n8n/schemas/outbound-message.schema.ts` — Add `integrations` to JSON schema
- `api/src/services/message-forwarding.service.ts` — Add `buildIntegrationsConfig()` payload builder
- `api/src/server.ts` — Mount booking routes + integrations routes
- `docs/n8n-workflows/chatbot-platform-v2-brain.json` — Add booking tools + prompt injection

---

### Task 1: BookingLog Entity + Migration

**Files:**
- Create: `api/src/database/entities/BookingLog.ts`
- Create: `api/src/database/migrations/1780000000000-CreateBookingLogs.ts`

- [ ] **Step 1: Create the BookingLog entity**

Create `api/src/database/entities/BookingLog.ts`:

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Tenant } from './Tenant';

@Entity('booking_logs')
@Index(['tenantId', 'createdAt'])
@Index(['tenantId', 'attendeeEmail'])
@Index(['calBookingId'])
@Unique(['tenantId', 'idempotencyKey'])
export class BookingLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant!: Tenant;

  @Column({ type: 'uuid', name: 'session_id' })
  sessionId!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'idempotency_key' })
  idempotencyKey?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'cal_booking_id' })
  calBookingId?: string;

  @Column({ type: 'varchar', length: 50, name: 'event_type' })
  eventType!: 'created' | 'rescheduled' | 'cancelled';

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'attendee_name' })
  attendeeName?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'attendee_email' })
  attendeeEmail?: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'start_time' })
  startTime?: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'end_time' })
  endTime?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
```

- [ ] **Step 2: Create the migration**

Create `api/src/database/migrations/1780000000000-CreateBookingLogs.ts`:

```typescript
import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateBookingLogs1780000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE booking_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        session_id UUID NOT NULL,
        idempotency_key VARCHAR(255),
        cal_booking_id VARCHAR(255),
        event_type VARCHAR(50) NOT NULL,
        attendee_name VARCHAR(255),
        attendee_email VARCHAR(255),
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(tenant_id, idempotency_key)
      );

      CREATE INDEX idx_booking_logs_tenant_created ON booking_logs(tenant_id, created_at);
      CREATE INDEX idx_booking_logs_tenant_email ON booking_logs(tenant_id, attendee_email);
      CREATE INDEX idx_booking_logs_cal_booking ON booking_logs(cal_booking_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS booking_logs;`);
  }
}
```

- [ ] **Step 3: Register entity in data-source.ts**

In `api/src/database/data-source.ts`, add `BookingLog` to the entities array. Find the existing entities import section and add:

```typescript
import { BookingLog } from './entities/BookingLog';
```

Then add `BookingLog` to the `entities: [...]` array.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd api && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add api/src/database/entities/BookingLog.ts api/src/database/migrations/1780000000000-CreateBookingLogs.ts api/src/database/data-source.ts
git commit -m "feat: add BookingLog entity and migration"
```

---

### Task 2: Integrations Zod Schema + Controller + Routes

**Files:**
- Create: `api/src/schemas/integrations.schema.ts`
- Create: `api/src/knowledge/integrations.controller.ts`
- Create: `api/src/knowledge/integrations.routes.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Create Zod schema**

Create `api/src/schemas/integrations.schema.ts`:

```typescript
import { z } from 'zod';

export const updateIntegrationsSchema = z.object({
  calcom: z.object({
    apiKey: z.string().min(1).optional().nullable(),
    eventTypeId: z.number().int().positive().optional(),
    collectFields: z.array(z.string()).min(1).max(10).default(['name', 'email']),
    language: z.enum(['en', 'nl', 'fr', 'de']).default('en'),
  }).optional().nullable(),
});

export type UpdateIntegrationsInput = z.infer<typeof updateIntegrationsSchema>;
```

- [ ] **Step 2: Create controller**

Create `api/src/knowledge/integrations.controller.ts`:

```typescript
import { Request, Response } from 'express';
import { AppDataSource } from '../database/data-source';
import { Tenant } from '../database/entities/Tenant';
import { encrypt } from '../utils/encryption';
import { logger } from '../utils/logger';
import { updateIntegrationsSchema } from '../schemas/integrations.schema';

export async function getIntegrations(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const integrations = tenant.settings?.integrations || {};
  const result: Record<string, any> = {};

  if (integrations.calcom) {
    const { apiKey, ...rest } = integrations.calcom;
    result.calcom = { ...rest, hasApiKey: !!apiKey };
  }

  res.json(result);
}

export async function updateIntegrations(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const data = updateIntegrationsSchema.parse(req.body);
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const existing = tenant.settings?.integrations || {};
  const updated: any = { ...existing };

  if (data.calcom === null) {
    // Remove Cal.com integration
    delete updated.calcom;
  } else if (data.calcom) {
    const existingCalcom = existing.calcom || {};
    updated.calcom = { ...existingCalcom };

    if (data.calcom.apiKey !== undefined) {
      updated.calcom.apiKey = data.calcom.apiKey ? encrypt(data.calcom.apiKey) : null;
    }
    if (data.calcom.eventTypeId) updated.calcom.eventTypeId = data.calcom.eventTypeId;
    if (data.calcom.collectFields) updated.calcom.collectFields = data.calcom.collectFields;
    if (data.calcom.language) updated.calcom.language = data.calcom.language;
  }

  tenant.settings = { ...tenant.settings, integrations: updated };
  await tenantRepo.save(tenant);

  // Return redacted response
  const response: Record<string, any> = {};
  if (updated.calcom) {
    const { apiKey, ...rest } = updated.calcom;
    response.calcom = { ...rest, hasApiKey: !!apiKey };
  }

  logger.info(`Integrations updated for tenant ${tenantId}`);
  res.json(response);
}
```

- [ ] **Step 3: Update Tenant.ts settings type and redact in GET response**

In `api/src/database/entities/Tenant.ts`, find the settings type definition and add `integrations?` to it. Also update `api/src/routes/tenants.ts` to redact `settings.integrations.calcom.apiKey` in the GET response, following the same pattern used for `settings.ai.apiKey`.

- [ ] **Step 4: Create routes**

Create `api/src/knowledge/integrations.routes.ts`:

```typescript
import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler';
import { requireClerkAuth, autoProvision } from '../middleware/clerk.middleware';
import { resolveTenantContext } from '../middleware/super-admin.middleware';
import { requireRole } from '../middleware/auth.middleware';
import * as ctrl from './integrations.controller';

const router = Router();

router.use(requireClerkAuth, autoProvision, resolveTenantContext);

// Read: admin, supervisor
router.get('/integrations', requireRole('admin', 'supervisor'), asyncHandler(ctrl.getIntegrations));

// Write: admin only
router.patch('/integrations', requireRole('admin'), asyncHandler(ctrl.updateIntegrations));

export default router;
```

- [ ] **Step 5: Mount in server.ts**

In `api/src/server.ts`, add the import:

```typescript
import integrationsRoutes from './knowledge/integrations.routes';
```

Mount it alongside the existing ai-settings route (around line 161):

```typescript
apiRouter.use('/tenants/me', integrationsRoutes);
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd api && npx tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add api/src/schemas/integrations.schema.ts api/src/knowledge/integrations.controller.ts api/src/knowledge/integrations.routes.ts api/src/server.ts
git commit -m "feat: add integrations controller with encrypt/redact for Cal.com credentials"
```

---

### Task 3: Booking Service (Cal.com API Client)

**Files:**
- Create: `api/src/n8n/booking.service.ts`

- [ ] **Step 1: Create the booking service**

Create `api/src/n8n/booking.service.ts`:

```typescript
import axios, { AxiosError } from 'axios';
import { AppDataSource } from '../database/data-source';
import { ChatSession } from '../database/entities/ChatSession';
import { Tenant } from '../database/entities/Tenant';
import { BookingLog } from '../database/entities/BookingLog';
import { decrypt } from '../utils/encryption';
import { logger } from '../utils/logger';

interface CalComConfig {
  apiKey: string;
  eventTypeId: number;
  timezone: string;
}

interface Slot {
  start: string;
  end: string;
}

interface BookingResult {
  id: string;
  startTime: string;
  endTime: string;
  attendee: { name: string; email: string };
}

interface BookingNotificationDetails {
  calBookingId: string;
  startTime: string;
  endTime?: string;
  attendeeName: string;
  attendeeEmail: string;
  notes?: string;
}

async function sendBookingNotification(
  type: 'created' | 'rescheduled' | 'cancelled',
  booking: BookingNotificationDetails,
  tenantName: string
): Promise<void> {
  // Step 1: log only. Resend integration configured separately later.
  logger.info(`[Booking] Email notification: ${type}`, { booking, tenantName });
}

async function resolveSessionTenant(sessionId: string): Promise<{ session: ChatSession; tenant: Tenant; calConfig: CalComConfig }> {
  const sessionRepo = AppDataSource.getRepository(ChatSession);
  const tenantRepo = AppDataSource.getRepository(Tenant);

  const session = await sessionRepo.findOne({ where: { id: sessionId } });
  if (!session) throw new BookingError('Session not found', 'SESSION_NOT_FOUND', 404);

  const tenant = await tenantRepo.findOne({ where: { id: session.tenantId } });
  if (!tenant) throw new BookingError('Tenant not found', 'TENANT_NOT_FOUND', 404);

  const calcom = tenant.settings?.integrations?.calcom;
  if (!calcom?.apiKey || !calcom?.eventTypeId) {
    throw new BookingError('Booking not configured for this tenant', 'BOOKING_NOT_CONFIGURED', 400);
  }

  const timezone = tenant.settings?.businessHours?.timezone || 'UTC';

  return {
    session,
    tenant,
    calConfig: {
      apiKey: decrypt(calcom.apiKey),
      eventTypeId: calcom.eventTypeId,
      timezone,
    },
  };
}

export class BookingError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

export async function listBookings(sessionId: string, attendeeEmail: string) {
  const { tenant } = await resolveSessionTenant(sessionId);

  const bookingLogRepo = AppDataSource.getRepository(BookingLog);
  const logs = await bookingLogRepo
    .createQueryBuilder('bl')
    .where('bl.tenant_id = :tenantId', { tenantId: tenant.id })
    .andWhere('bl.attendee_email = :email', { email: attendeeEmail })
    .andWhere('bl.event_type != :cancelled', { cancelled: 'cancelled' })
    .andWhere('bl.cal_booking_id IS NOT NULL')
    .orderBy('bl.created_at', 'DESC')
    .getMany();

  // Deduplicate by calBookingId (keep latest)
  const seen = new Set<string>();
  const unique = logs.filter(log => {
    if (!log.calBookingId || seen.has(log.calBookingId)) return false;
    seen.add(log.calBookingId);
    return true;
  });

  return {
    bookings: unique.map(log => ({
      id: log.calBookingId,
      startTime: log.startTime?.toISOString(),
      endTime: log.endTime?.toISOString(),
      attendee: { name: log.attendeeName, email: log.attendeeEmail },
      status: 'accepted',
    })),
  };
}

export async function checkAvailability(sessionId: string, startDate: string, endDate: string) {
  const { calConfig } = await resolveSessionTenant(sessionId);

  try {
    const response = await axios.get('https://api.cal.com/v2/slots', {
      params: {
        eventTypeId: calConfig.eventTypeId,
        timeZone: calConfig.timezone,
        start: startDate,
        end: endDate,
      },
      headers: {
        'Authorization': `Bearer ${calConfig.apiKey}`,
        'cal-api-version': '2024-09-04',
      },
      timeout: 10000,
    });

    const slotsData = response.data?.data || response.data?.slots || {};
    const slots: Slot[] = [];

    // Cal.com returns slots grouped by date
    for (const dateSlots of Object.values(slotsData)) {
      if (Array.isArray(dateSlots)) {
        for (const slot of dateSlots) {
          slots.push({
            start: slot.start || slot.time,
            end: slot.end || '',
          });
        }
      }
    }

    return { slots, timezone: calConfig.timezone };
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status && error.response.status >= 500) {
      throw new BookingError('Cal.com is currently unavailable', 'BOOKING_UNAVAILABLE', 503);
    }
    throw new BookingError(
      `Failed to check availability: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'AVAILABILITY_CHECK_FAILED',
      502
    );
  }
}

export async function createBooking(
  sessionId: string,
  idempotencyKey: string,
  startTime: string,
  attendee: { name: string; email: string },
  notes?: string
) {
  const { tenant, calConfig } = await resolveSessionTenant(sessionId);
  const bookingLogRepo = AppDataSource.getRepository(BookingLog);

  // Idempotency check
  const existing = await bookingLogRepo.findOne({
    where: { tenantId: tenant.id, idempotencyKey },
  });
  if (existing) {
    return {
      success: true,
      idempotent: true,
      booking: {
        id: existing.calBookingId,
        startTime: existing.startTime?.toISOString(),
        endTime: existing.endTime?.toISOString(),
        attendee: { name: existing.attendeeName, email: existing.attendeeEmail },
      },
    };
  }

  try {
    const response = await axios.post('https://api.cal.com/v2/bookings', {
      eventTypeId: calConfig.eventTypeId,
      start: startTime,
      attendee: {
        name: attendee.name,
        email: attendee.email,
        timeZone: calConfig.timezone,
        language: 'en',
      },
      bookingFieldsResponses: {
        notes: notes || '',
      },
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${calConfig.apiKey}`,
        'cal-api-version': '2024-08-13',
      },
      timeout: 15000,
    });

    const booking = response.data?.data || response.data;
    const calBookingId = booking?.id?.toString() || booking?.uid || '';
    const endTime = booking?.endTime || booking?.end || '';

    // Save to booking log
    const log = bookingLogRepo.create({
      tenantId: tenant.id,
      sessionId,
      idempotencyKey,
      calBookingId,
      eventType: 'created',
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      startTime: new Date(startTime),
      endTime: endTime ? new Date(endTime) : undefined,
      notes,
    });
    await bookingLogRepo.save(log);

    await sendBookingNotification('created', {
      calBookingId,
      startTime,
      endTime,
      attendeeName: attendee.name,
      attendeeEmail: attendee.email,
      notes,
    }, tenant.name);

    return {
      success: true,
      booking: {
        id: calBookingId,
        startTime,
        endTime,
        attendee,
      },
    };
  } catch (error) {
    if (error instanceof AxiosError) {
      if (error.response?.status === 409) {
        throw new BookingError('This time slot is no longer available', 'SLOT_UNAVAILABLE', 409);
      }
      if (error.response?.status && error.response.status >= 500) {
        throw new BookingError('Cal.com is currently unavailable', 'BOOKING_UNAVAILABLE', 503);
      }
    }
    throw new BookingError(
      `Failed to create booking: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'BOOKING_CREATE_FAILED',
      502
    );
  }
}

export async function rescheduleBooking(
  sessionId: string,
  bookingId: string,
  newStartTime: string
) {
  const { tenant, calConfig } = await resolveSessionTenant(sessionId);
  const bookingLogRepo = AppDataSource.getRepository(BookingLog);

  // Ownership validation
  const existingLog = await bookingLogRepo.findOne({
    where: { tenantId: tenant.id, calBookingId: bookingId, eventType: 'created' },
  });
  if (!existingLog) {
    throw new BookingError('Booking not found for this tenant', 'BOOKING_NOT_FOUND', 404);
  }

  try {
    const response = await axios.post(`https://api.cal.com/v2/bookings/${bookingId}/reschedule`, {
      start: newStartTime,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${calConfig.apiKey}`,
        'cal-api-version': '2024-08-13',
      },
      timeout: 15000,
    });

    const booking = response.data?.data || response.data;
    const endTime = booking?.endTime || booking?.end || '';

    // Log the reschedule
    const log = bookingLogRepo.create({
      tenantId: tenant.id,
      sessionId,
      calBookingId: bookingId,
      eventType: 'rescheduled',
      attendeeName: existingLog.attendeeName,
      attendeeEmail: existingLog.attendeeEmail,
      startTime: new Date(newStartTime),
      endTime: endTime ? new Date(endTime) : undefined,
    });
    await bookingLogRepo.save(log);

    await sendBookingNotification('rescheduled', {
      calBookingId: bookingId,
      startTime: newStartTime,
      endTime,
      attendeeName: existingLog.attendeeName || '',
      attendeeEmail: existingLog.attendeeEmail || '',
    }, tenant.name);

    return {
      success: true,
      booking: {
        id: bookingId,
        startTime: newStartTime,
        endTime,
      },
    };
  } catch (error) {
    if (error instanceof BookingError) throw error;
    if (error instanceof AxiosError && error.response?.status && error.response.status >= 500) {
      throw new BookingError('Cal.com is currently unavailable', 'BOOKING_UNAVAILABLE', 503);
    }
    throw new BookingError(
      `Failed to reschedule: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'RESCHEDULE_FAILED',
      502
    );
  }
}

export async function cancelBooking(
  sessionId: string,
  bookingId: string,
  reason?: string
) {
  const { tenant, calConfig } = await resolveSessionTenant(sessionId);
  const bookingLogRepo = AppDataSource.getRepository(BookingLog);

  // Ownership validation
  const existingLog = await bookingLogRepo.findOne({
    where: { tenantId: tenant.id, calBookingId: bookingId, eventType: 'created' },
  });
  if (!existingLog) {
    throw new BookingError('Booking not found for this tenant', 'BOOKING_NOT_FOUND', 404);
  }

  try {
    await axios.delete(`https://api.cal.com/v2/bookings/${bookingId}/cancel`, {
      data: { cancellationReason: reason || 'Cancelled by customer' },
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${calConfig.apiKey}`,
        'cal-api-version': '2024-08-13',
      },
      timeout: 15000,
    });

    // Log the cancellation
    const log = bookingLogRepo.create({
      tenantId: tenant.id,
      sessionId,
      calBookingId: bookingId,
      eventType: 'cancelled',
      attendeeName: existingLog.attendeeName,
      attendeeEmail: existingLog.attendeeEmail,
      startTime: existingLog.startTime,
      notes: reason,
    });
    await bookingLogRepo.save(log);

    await sendBookingNotification('cancelled', {
      calBookingId: bookingId,
      startTime: existingLog.startTime?.toISOString() || '',
      attendeeName: existingLog.attendeeName || '',
      attendeeEmail: existingLog.attendeeEmail || '',
    }, tenant.name);

    return { success: true, cancelled: true };
  } catch (error) {
    if (error instanceof BookingError) throw error;
    if (error instanceof AxiosError && error.response?.status && error.response.status >= 500) {
      throw new BookingError('Cal.com is currently unavailable', 'BOOKING_UNAVAILABLE', 503);
    }
    throw new BookingError(
      `Failed to cancel: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'CANCEL_FAILED',
      502
    );
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd api && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add api/src/n8n/booking.service.ts
git commit -m "feat: add booking service with Cal.com API client, idempotency, and ownership validation"
```

---

### Task 4: Booking Routes (5 Internal Endpoints)

**Files:**
- Create: `api/src/n8n/booking.routes.ts`
- Modify: `api/src/server.ts`

- [ ] **Step 1: Create booking routes**

Create `api/src/n8n/booking.routes.ts`:

```typescript
import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { body, validationResult } from 'express-validator';
import { config } from '../config/environment';
import { logger } from '../utils/logger';
import {
  listBookings,
  checkAvailability,
  createBooking,
  rescheduleBooking,
  cancelBooking,
  BookingError,
} from './booking.service';

const router = Router();

function verifyInternalAuth(req: Request, res: Response, next: NextFunction): void {
  const secret = config.n8n.ragInternalSecret;
  if (!secret) {
    res.status(503).json({ error: 'Booking endpoint not configured' });
    return;
  }

  const authHeader = req.headers.authorization || '';
  const expected = `Bearer ${secret}`;
  if (authHeader.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

function validate(req: Request, res: Response, next: NextFunction): void {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: 'Validation failed', details: errors.array() });
    return;
  }
  next();
}

function handleBookingError(error: unknown, res: Response): void {
  if (error instanceof BookingError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  logger.error('[Booking] Unexpected error', error);
  res.status(500).json({ error: 'Internal error' });
}

// POST /list
router.post('/list', verifyInternalAuth, [
  body('sessionId').isUUID(),
  body('attendeeEmail').isEmail(),
], validate, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await listBookings(req.body.sessionId, req.body.attendeeEmail);
    res.json(result);
  } catch (error) { handleBookingError(error, res); }
});

// POST /availability
router.post('/availability', verifyInternalAuth, [
  body('sessionId').isUUID(),
  body('startDate').isISO8601(),
  body('endDate').isISO8601(),
], validate, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await checkAvailability(req.body.sessionId, req.body.startDate, req.body.endDate);
    res.json(result);
  } catch (error) { handleBookingError(error, res); }
});

// POST /create
router.post('/create', verifyInternalAuth, [
  body('sessionId').isUUID(),
  body('idempotencyKey').isString().notEmpty(),
  body('startTime').isISO8601(),
  body('attendee.name').isString().notEmpty(),
  body('attendee.email').isEmail(),
  body('notes').optional().isString(),
], validate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId, idempotencyKey, startTime, attendee, notes } = req.body;
    const result = await createBooking(sessionId, idempotencyKey, startTime, attendee, notes);
    res.json(result);
  } catch (error) { handleBookingError(error, res); }
});

// POST /reschedule
router.post('/reschedule', verifyInternalAuth, [
  body('sessionId').isUUID(),
  body('bookingId').isString().notEmpty(),
  body('newStartTime').isISO8601(),
], validate, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await rescheduleBooking(req.body.sessionId, req.body.bookingId, req.body.newStartTime);
    res.json(result);
  } catch (error) { handleBookingError(error, res); }
});

// POST /cancel
router.post('/cancel', verifyInternalAuth, [
  body('sessionId').isUUID(),
  body('bookingId').isString().notEmpty(),
  body('reason').optional().isString(),
], validate, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await cancelBooking(req.body.sessionId, req.body.bookingId, req.body.reason);
    res.json(result);
  } catch (error) { handleBookingError(error, res); }
});

export default router;
```

- [ ] **Step 2: Mount in server.ts**

In `api/src/server.ts`, add the import:

```typescript
import bookingRoutes from './n8n/booking.routes';
```

Mount it after the RAG search route (around line 244):

```typescript
    // Internal booking endpoints for n8n
    apiRouter.use('/internal/booking', bookingRoutes);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd api && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add api/src/n8n/booking.routes.ts api/src/server.ts
git commit -m "feat: add 5 internal booking endpoints (list, availability, create, reschedule, cancel)"
```

---

### Task 5: Outbound Payload Enrichment (Integrations Config)

**Files:**
- Modify: `api/src/n8n/types/message.types.ts`
- Modify: `api/src/n8n/schemas/outbound-message.schema.ts`
- Modify: `api/src/services/message-forwarding.service.ts`

- [ ] **Step 1: Add IntegrationsConfig type**

In `api/src/n8n/types/message.types.ts`, add before the `OutboundMessage` interface:

```typescript
export interface IntegrationsConfig {
  calcom?: {
    enabled: boolean;
    language: string;
    collectFields: string[];
    timezone: string;
  };
}
```

Then add `integrations?: IntegrationsConfig;` to the `OutboundMessage` interface.

- [ ] **Step 2: Update JSON schema**

In `api/src/n8n/schemas/outbound-message.schema.ts`, add inside the `properties` object (after `knowledgeBase`):

```typescript
    integrations: {
      type: 'object',
      additionalProperties: true,
      properties: {
        calcom: {
          type: 'object',
          additionalProperties: true,
          properties: {
            enabled: { type: 'boolean' },
            language: { type: 'string' },
            collectFields: { type: 'array', items: { type: 'string' } },
            timezone: { type: 'string' },
          },
        },
      },
    },
```

- [ ] **Step 3: Add payload builder**

In `api/src/services/message-forwarding.service.ts`, add a new helper function after `buildKnowledgeBaseMetadata`:

```typescript
function buildIntegrationsConfig(tenant: Tenant): IntegrationsConfig | undefined {
  const calcom = tenant.settings?.integrations?.calcom;
  if (!calcom?.apiKey || !calcom?.eventTypeId) return undefined;

  const timezone = tenant.settings?.businessHours?.timezone || 'UTC';

  return {
    calcom: {
      enabled: true,
      language: calcom.language || 'en',
      collectFields: calcom.collectFields || ['name', 'email'],
      timezone,
    },
  };
}
```

Add the `IntegrationsConfig` import from `'../n8n/types/message.types'`.

Then in the `forwardMessageToN8n` function, add `integrations` to the outbound payload (alongside `tenantConfig` and `knowledgeBase`):

```typescript
    integrations: buildIntegrationsConfig(tenant),
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd api && npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add api/src/n8n/types/message.types.ts api/src/n8n/schemas/outbound-message.schema.ts api/src/services/message-forwarding.service.ts
git commit -m "feat: add integrations config to outbound payload"
```

---

### Task 6: Update n8n Workflow (Booking Tools + Prompt Injection)

**Files:**
- Modify: `docs/n8n-workflows/chatbot-platform-v2-brain.json`

This task updates the n8n workflow JSON to:
1. Parse `integrations` from the payload in Extract Message
2. Inject booking instructions in Build System Prompt when Cal.com is enabled
3. Add 5 booking tool nodes to the AI Agent

- [ ] **Step 1: Read the current workflow**

Read `docs/n8n-workflows/chatbot-platform-v2-brain.json` to understand the current node structure.

- [ ] **Step 2: Update Extract Message node**

In the Extract Message node's `jsCode`, add to the return object:

```javascript
integrations: body.integrations || {},
```

- [ ] **Step 3: Update Build System Prompt node**

In the Build System Prompt node's `jsCode`, add after the KB context section and before the RULES section:

```javascript
// ── Booking integration ──────────────────────────────────────────────────
const integrations = extractData.integrations || {};
if (integrations.calcom?.enabled) {
  const collectFields = (integrations.calcom.collectFields || ['name', 'email']).join(', ');
  const tz = integrations.calcom.timezone || 'UTC';
  const lang = integrations.calcom.language || 'en';

  const bookingPrompts = {
    en: `\n\nBOOKING ASSISTANT\nYou have access to booking tools: list_bookings, check_availability, create_booking, reschedule_booking, cancel_booking.\n\nTODAY: ${new Date().toISOString().split('T')[0]}\n\nBOOKING FLOW:\n1. Detect booking intent (book, appointment, schedule, etc.)\n2. Ask when they'd like to come\n3. Call check_availability with the date — NEVER assume availability\n4. Show available slots, ask them to pick\n5. Collect: ${collectFields}\n6. Confirm all details with the customer\n7. On confirmation, call create_booking\n\nRESCHEDULE FLOW:\n1. Call list_bookings with the customer's email to find their booking\n2. Ask for new preferred date\n3. Call check_availability for the new date\n4. Show slots, confirm new time\n5. Call reschedule_booking\n\nCANCEL FLOW:\n1. Call list_bookings with the customer's email to find their booking\n2. Confirm cancellation with the customer\n3. Call cancel_booking\n\nRULES:\n- Check conversation history — don't restart completed steps\n- Don't call check_availability twice for the same date\n- Always confirm before creating/rescheduling/cancelling\n- Timezone: ${tz}`,
    nl: `\n\nBOEKINGS ASSISTENT\nJe hebt toegang tot boekingstools: list_bookings, check_availability, create_booking, reschedule_booking, cancel_booking.\n\nVANDAAG: ${new Date().toISOString().split('T')[0]}\n\nBOEKINGS FLOW:\n1. Detecteer boekingsintentie (boeken, afspraak, plannen, etc.)\n2. Vraag wanneer ze willen komen\n3. Bel check_availability voor die datum — ga NOOIT uit van beschikbaarheid\n4. Toon beschikbare tijdsloten, vraag om te kiezen\n5. Verzamel: ${collectFields}\n6. Bevestig alle details met de klant\n7. Bij bevestiging, bel create_booking\n\nWIJZIGINGS FLOW:\n1. Bel list_bookings met het e-mailadres van de klant\n2. Vraag naar de nieuwe gewenste datum\n3. Bel check_availability voor de nieuwe datum\n4. Toon tijdsloten, bevestig nieuwe tijd\n5. Bel reschedule_booking\n\nANNULERINGS FLOW:\n1. Bel list_bookings met het e-mailadres van de klant\n2. Bevestig annulering met de klant\n3. Bel cancel_booking\n\nREGELS:\n- Controleer gespreksgeschiedenis — herstart geen voltooide stappen\n- Bel check_availability niet twee keer voor dezelfde datum\n- Bevestig altijd voordat je boekt/wijzigt/annuleert\n- Tijdzone: ${tz}`,
  };

  systemPrompt += bookingPrompts[lang] || bookingPrompts.en;
}
```

- [ ] **Step 4: Add 5 booking tool nodes to the AI Agent**

Add these tool sub-nodes connected to the AI Agent via `ai_tool` connections. Each tool uses `toolHttpRequest` type with:
- URL: `={{ $env.API_URL || 'http://localhost:3000' }}/api/v1/internal/booking/{endpoint}`
- Authorization header: `Bearer {{ $env.RAG_INTERNAL_SECRET }}`
- `sessionId` in the body is static: `{{ $('Extract Message').item.json.sessionId }}`
- Other fields are placeholders filled by the AI agent

The 5 tools are: `list_bookings`, `check_availability`, `create_booking`, `reschedule_booking`, `cancel_booking`.

For each tool, create a node with the appropriate:
- `toolDescription` (tells the AI when to use it)
- `url` (the platform endpoint)
- `method` (POST for all)
- `sendHeaders` with Authorization and Content-Type
- `sendBody` with `specifyBody: "json"` and a `jsonBody` template
- `placeholderDefinitions` for AI-filled fields
- `onError: "continueRegularOutput"`

Add connections from each tool node to the AI Agent via `ai_tool` type.

- [ ] **Step 5: Commit**

```bash
git add docs/n8n-workflows/chatbot-platform-v2-brain.json
git commit -m "feat: add booking tools and prompt injection to v2 n8n workflow"
```

---

### Task 7: Unit Tests

**Files:**
- Create: `api/src/__tests__/unit/booking-service.test.ts`
- Create: `api/src/__tests__/unit/booking-routes.test.ts`
- Create: `api/src/__tests__/unit/integrations-controller.test.ts`

- [ ] **Step 1: Write booking service unit tests**

Create `api/src/__tests__/unit/booking-service.test.ts`. Test:
- `resolveSessionTenant` throws BookingError when session not found
- `resolveSessionTenant` throws BookingError when booking not configured
- `createBooking` returns idempotent response on duplicate key
- `rescheduleBooking` throws BookingError when booking not found (ownership validation)
- `cancelBooking` throws BookingError when booking not found (ownership validation)

Mock: `AppDataSource.getRepository`, `axios`, `decrypt`

- [ ] **Step 2: Write booking routes unit tests**

Create `api/src/__tests__/unit/booking-routes.test.ts`. Test:
- Auth: 503 when secret not configured, 401 when wrong token, 200 with valid token
- Validation: 400 for missing sessionId, invalid email, invalid dates
- Error mapping: BookingError → correct status codes

Use supertest with a minimal Express app (same pattern as rag-search-routes.test.ts).

- [ ] **Step 3: Write integrations controller unit tests**

Create `api/src/__tests__/unit/integrations-controller.test.ts`. Test:
- `getIntegrations` returns hasApiKey flag (never raw key)
- `updateIntegrations` encrypts API key before saving
- `updateIntegrations` with null calcom removes integration
- Redacted response never includes apiKey

- [ ] **Step 4: Run all unit tests**

```bash
cd api && npx vitest run --config vitest.unit.config.ts src/__tests__/unit/booking-service.test.ts src/__tests__/unit/booking-routes.test.ts src/__tests__/unit/integrations-controller.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add api/src/__tests__/unit/
git commit -m "test: add unit tests for booking service, routes, and integrations controller"
```

---

### Task 8: TypeScript Compilation Check + Final Verification

- [ ] **Step 1: Full TypeScript check**

```bash
cd api && npx tsc --noEmit
```

- [ ] **Step 2: Run all unit tests**

```bash
cd api && npx vitest run --config vitest.unit.config.ts
```

- [ ] **Step 3: Verify all imports are correct in server.ts**

Read `api/src/server.ts` and verify:
- `bookingRoutes` imported and mounted at `/internal/booking`
- `integrationsRoutes` imported and mounted at `/tenants/me`
- Both routes are outside the webhook try/catch block

---

## Summary

| Task | Description | Additive? |
|------|-------------|-----------|
| 1 | BookingLog entity + migration | Yes |
| 2 | Integrations controller (encrypt/redact) | Yes |
| 3 | Booking service (Cal.com API client) | Yes |
| 4 | Booking routes (5 internal endpoints) | Yes |
| 5 | Outbound payload enrichment | Yes |
| 6 | n8n workflow update (tools + prompt) | Yes |
| 7 | Unit tests | Yes |
| 8 | Final verification | N/A |

All tasks are additive — no breaking changes. The n8n workflow update (Task 6) should be imported after deploying Tasks 1-5.

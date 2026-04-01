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

  // Accept token via Authorization header OR _auth body field
  // (n8n toolHttpRequest nodes cannot send custom headers)
  const authHeader = req.headers.authorization || '';
  const bodyAuth = req.body?._auth ? `Bearer ${req.body._auth}` : '';
  const token = authHeader || bodyAuth;

  const expected = `Bearer ${secret}`;
  if (token.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Remove _auth from body so downstream handlers don't see it
  if (req.body?._auth) {
    delete req.body._auth;
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
    res.json({ data: result });
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
    res.json({ data: result });
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
    res.json({ data: result });
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
    res.json({ data: result });
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
    res.json({ data: result });
  } catch (error) { handleBookingError(error, res); }
});

export default router;

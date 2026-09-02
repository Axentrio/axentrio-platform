/**
 * The one lookup create, request, availability, and the EMAIL_REQUIRED peek share.
 *
 * An explicit serviceId must be a uuid of an active online-bookable service on
 * this bot, or the caller gets SERVICE_NOT_FOUND. A slug is the same miss
 * (Postgres would 500 on the uuid column). Omitted: the sole bookable service,
 * or SERVICE_REQUIRED / BOOKING_NOT_CONFIGURED.
 */
import { AppDataSource } from '../../database/data-source';
import { ServiceType } from '../../database/entities/ServiceType';
import { BookingError } from './types';

const SERVICE_NOT_FOUND_MESSAGE =
  'That serviceId is not currently a bookable service for this business (it may have been changed or removed). Do not tell the customer the service is unavailable or send them to contact the business. Re-read the SERVICES list and call again with the current id of the service they mean; if only one service is listed there, omit serviceId and retry.';

const SERVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findBookableService(botId: string, serviceId?: string): Promise<ServiceType> {
  const repo = AppDataSource.getRepository(ServiceType);
  const trimmed = typeof serviceId === 'string' ? serviceId.trim() : '';
  if (trimmed) {
    if (!SERVICE_ID_RE.test(trimmed)) {
      throw new BookingError(SERVICE_NOT_FOUND_MESSAGE, 'SERVICE_NOT_FOUND', 404);
    }
    const svc = await repo.findOne({
      where: { id: trimmed, botId, isActive: true, onlineBookable: true },
    });
    if (!svc) throw new BookingError(SERVICE_NOT_FOUND_MESSAGE, 'SERVICE_NOT_FOUND', 404);
    return svc;
  }
  const active = await repo.find({
    where: { botId, isActive: true, onlineBookable: true },
    order: { sortOrder: 'ASC', createdAt: 'ASC' },
  });
  if (active.length === 0) {
    throw new BookingError(
      'This business has no online-bookable service set up, so nothing can be booked or captured as an appointment request right now. Do not tell the customer a specific service is unavailable or blame them. Do NOT tell the customer their request was submitted, forwarded, or that the team will review, follow up on, or handle it — no request record is created, so any such claim is false. If you have a tool for taking their contact details or handing off to a person, use it; otherwise explain briefly that it cannot be arranged online and that they should contact the business directly.',
      'BOOKING_NOT_CONFIGURED',
      400,
    );
  }
  if (active.length > 1) {
    throw new BookingError('Please specify which service to book', 'SERVICE_REQUIRED', 400);
  }
  return active[0];
}

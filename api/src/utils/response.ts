import { Response } from 'express';

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function sendSuccess<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  res.json({ success: true, data, ...(meta && { meta }) });
}

export function sendPaginated<T>(res: Response, data: T[], pagination: PaginationMeta): void {
  res.json({
    success: true,
    data,
    meta: { pagination },
  });
}

export function sendCreated<T>(res: Response, data: T): void {
  res.status(201).json({ success: true, data });
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}

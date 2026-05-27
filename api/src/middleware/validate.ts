import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { ValidationError } from './error-handler';

type Source = 'body' | 'query' | 'params';

export function validate(schema: ZodSchema, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      throw new ValidationError('Validation failed', result.error.flatten() as unknown as Record<string, unknown>);
    }
    (req as unknown as Record<string, unknown>)[source] = result.data;
    next();
  };
}

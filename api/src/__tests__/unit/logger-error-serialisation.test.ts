/**
 * An Error in the metadata has to survive the trip to the log.
 *
 * `logger.error('msg', { error })` is the shape used at 27 call sites in this codebase, and until
 * now every one of them logged `error={}`. `format.errors({ stack: true })` only unwraps an Error
 * passed AS the log item, and `JSON.stringify(new Error('x'))` is `{}` because `message` and
 * `stack` are non-enumerable.
 *
 * Found in production while trying to read why a customer had been sent the fallback message. The
 * line said `Agent loop error error={}` and there was nothing else to go on.
 *
 * The FORMAT is tested rather than the logger: winston's transport writes asynchronously through
 * its own stream, so asserting on stdout tests the plumbing and not the transform that was fixed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readableErrors } from '../../utils/logger';

/** Apply the format exactly as winston would, and hand back what a transport would serialise. */
const applied = (meta: Record<string, unknown>) =>
  readableErrors().transform({ level: 'error', message: 'x', ...meta }) as Record<string, unknown>;

describe('an Error logged inside metadata', () => {
  it('keeps its message and stack instead of serialising to nothing', () => {
    const out = applied({ error: new Error('the real reason') });
    const error = out.error as { message: string; name: string; stack: string };

    expect(error.message).toBe('the real reason');
    expect(error.name).toBe('Error');
    expect(error.stack).toContain('the real reason');
    // The exact symptom this guards: a plain object with nothing in it.
    expect(JSON.stringify(out.error)).not.toBe('{}');
  });

  it('carries a cause chain, where a wrapped driver error hides its reason', () => {
    const out = applied({ error: new Error('outer', { cause: new Error('inner truth') }) });
    expect(JSON.stringify(out.error)).toContain('inner truth');
  });

  it('converts EVERY error-valued key, not only one called `error`', () => {
    // Call sites use `err`, `cause` and `reason` too. Keying on the name would fix one of them.
    const out = applied({ err: new Error('first'), reason: new Error('second') });
    expect(JSON.stringify(out.err)).toContain('first');
    expect(JSON.stringify(out.reason)).toContain('second');
  });

  it('leaves ordinary metadata untouched', () => {
    // The format walks every key, so a non-Error value must come through unchanged or this fix
    // quietly rewrites unrelated log fields.
    const nested = { a: 1 };
    const out = applied({ tenantId: 'ten-1', count: 3, nested });

    expect(out.tenantId).toBe('ten-1');
    expect(out.count).toBe(3);
    expect(out.nested).toBe(nested);
  });
});

describe('the format is actually wired in', () => {
  // The transform tests above prove it WORKS. They do not prove it RUNS: an unused format is a
  // passing test suite and an unchanged production log, which is exactly the state this file
  // exists to leave behind.
  const src = readFileSync(join(__dirname, '..', '..', 'utils', 'logger.ts'), 'utf8');

  it('runs in production, where the blind logs were', () => {
    expect(src).toMatch(/const prodFormat = winston\.format\.combine\(\s*\n\s*readableErrors\(\),/);
  });

  it('runs in development too, so the two do not disagree about what an error looks like', () => {
    expect(src).toMatch(/const devFormat = winston\.format\.combine\(\s*\n\s*readableErrors\(\),/);
  });

  it('runs BEFORE json(), or the Error is already flattened by the time it arrives', () => {
    const prod = src.slice(src.indexOf('const prodFormat'), src.indexOf('// Colorized console format'));
    expect(prod.indexOf('readableErrors()')).toBeLessThan(prod.indexOf('winston.format.json()'));
  });
});

/**
 * #73 - every booking error that can reach a customer has to have DECIDED what they read.
 *
 * `BookingError.message` is written for the model. `booking.tool.ts` feeds it to the LLM
 * verbatim, so it reads as stage directions. The signed manage and reschedule pages render
 * errors to a human being's browser. Those two audiences met once already, and a customer
 * clicking Reschedule at a business with no connected calendar would have read the bot's
 * instructions.
 *
 * The first fix was an allow-list in the controller, and the ticket's objection to it is the
 * reason this file exists: it kept the two audiences in sync BY HAND. A code added to the engine
 * with no entry degraded to "This link is invalid or has expired." - safe, and back to the
 * uninformative message the exercise set out to remove. Nothing failed. Nobody found out.
 *
 * So this reads the engine's OWN THROW SITES and requires a decision for each code: customer
 * copy at the throw site, an entry in the allow-list, or an explicit place on the
 * `NEVER_REACHES_A_CUSTOMER` list below. Adding a code without choosing fails here, which is
 * the difference between a list somebody maintains and a rule the build enforces.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { CUSTOMER_MESSAGE, customerMessage } from '../../scheduler/booking-public.controller';
import { BookingError } from '../../booking/booking-providers/types';

/** Vocabulary that only ever makes sense to the model. */
const BOT_DIRECTIVE =
  /request_appointment|reschedule_booking|check_availability|list_bookings|do not offer|do not say|capture it with|the bot\b|tell the customer/i;

/**
 * Codes that CANNOT reach a customer-facing surface, each with the reason it cannot.
 *
 * The public pages act on an existing booking behind a signed token: they read it, offer times,
 * cancel it, or move it. Nothing here is reachable from those four things - these are raised
 * while CREATING a booking through the agent, or by an owner-only admin path.
 *
 * The point of naming them is that "cannot reach a customer" becomes a claim somebody wrote down
 * rather than an absence nobody noticed. If one of these ever does reach the manage page, the
 * fix is customer copy at its throw site, not an addition here.
 */
const NEVER_REACHES_A_CUSTOMER: Record<string, string> = {
  INTAKE_REQUIRED: 'the agent re-asks and re-calls the tool while CREATING a booking',
  ADDRESS_REQUIRED: 'raised while the agent collects details for a NEW booking',
  ADDRESS_BINDING_CHANGED: 'raised only while the agent atomically creates a NEW booking or request',
  BOOKING_NOT_CONFIGURED: 'the owner has not finished setup; no manage link can exist yet',
  BOOKING_PROVIDER_UNSUPPORTED: 'admin path only - a non-internal booking is not manageable here',
  BOT_NOT_FOUND: 'owner-side Agent selection; the public path resolves its Agent from the booking',
  CAPACITY_REACHED: 'a ceiling on NEW bookings; a reschedule is checked as SLOT_UNAVAILABLE',
  DURATION_OUT_OF_RANGE: 'agent-side service configuration while creating',
  DURATION_REQUIRED: 'the agent re-asks for a length while CREATING a booking',
  FILE_NOT_READY: 'attachment upload during creation',
  FILE_UPLOAD_NOT_ALLOWED: 'attachment upload during creation',
  TOO_MANY_FILES: 'attachment upload during creation',
  INVALID_RANGE: 'a malformed availability query the public page never constructs',
  INVALID_START_TIME: 'a malformed time the public page never constructs - its times come from the offered list',
  NOT_A_REQUEST: 'owner-only accept/decline',
  PHONE_REQUIRED: 'raised while the agent collects details for a NEW booking',
  REQUEST_ALREADY_HANDLED: 'owner-only accept/decline',
  REQUEST_EXPIRED: 'owner-only accept/decline',
  REQUEST_WOULD_DUPLICATE: 'owner-only accept - the customer never sees the Requests tab',
  SERVICE_NOT_FOUND: 'agent-side service selection while creating',
  SESSION_NOT_FOUND: 'there is no chat session behind a signed manage link',
  TENANT_NOT_FOUND: 'a data-integrity failure, not a customer-actionable state',
  BOOKING_NOT_CANCELLABLE: 'the page checks the status itself and says so before offering the button',
  BOOKING_NOT_RESCHEDULABLE: 'the page checks the status itself and says so before offering the button',
};

/** Every `.ts` under a directory, recursively, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== '__tests__') out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `new BookingError(...)` raised in the booking engine, by code, with how many of its
 * throw sites supply customer copy.
 *
 * Argument positions are counted by walking the call and tracking nesting, because the copy is
 * the FIFTH argument and several of these calls span lines and contain template literals,
 * ternaries and nested calls with commas of their own. A regex that counted bare commas would
 * report copy where there is none, which is the one direction this test must never be wrong in.
 */
function thrownSites(): Map<string, { sites: number; withCopy: number }> {
  const found = new Map<string, { sites: number; withCopy: number }>();
  const root = join(__dirname, '..', '..');
  for (const file of [...sourceFiles(join(root, 'booking')), ...sourceFiles(join(root, 'scheduler'))]) {
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(/new BookingError\(/g)) {
      const open = match.index! + match[0].length - 1;
      const args = splitArgs(src, open);
      if (args.length < 2) continue;
      const code = args[1].trim().match(/^'([A-Z_]{3,})'$/)?.[1];
      if (!code) continue;
      const entry = found.get(code) ?? { sites: 0, withCopy: 0 };
      entry.sites += 1;
      // A 5th argument that is not literally `undefined` is customer copy.
      if (args.length >= 5 && args[4].trim() !== 'undefined') entry.withCopy += 1;
      found.set(code, entry);
    }
  }
  return found;
}

/** Split the arguments of a call whose `(` sits at `open`, respecting nesting and strings. */
function splitArgs(src: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      current += ch;
      if (ch === '\\') {
        current += src[++i] ?? '';
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      if (depth === 1) continue; // the opening paren of the call itself
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        args.push(current);
        return args;
      }
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 1) {
      args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  return args;
}

describe('every booking error has decided what a customer reads', () => {
  it('finds the throw sites at all - the scan is the test', () => {
    // If this ever returns nothing, every assertion below passes vacuously and the file becomes
    // decoration. Pinned to a floor rather than an exact count so ordinary additions do not
    // fail it.
    expect(thrownSites().size).toBeGreaterThan(15);
  });

  it('reads the fifth argument, or it cannot tell a decided throw site from an undecided one', () => {
    // The scan's own guard. `TRAVEL_TIME_CONFLICT` is raised twice and both sites carry customer
    // copy; if the argument walk broke, this would read 0 and the coverage assertion below would
    // start demanding entries for codes that are already decided.
    const travel = thrownSites().get('TRAVEL_TIME_CONFLICT');
    expect(travel).toBeDefined();
    expect(travel!.withCopy).toBe(travel!.sites);
  });

  it('every code is either customer-facing copy or explicitly ruled out', () => {
    const undecided = [...thrownSites()]
      .filter(([code, { sites, withCopy }]) => {
        if (withCopy === sites) return false; // decided at every throw site
        return !(code in CUSTOMER_MESSAGE) && !(code in NEVER_REACHES_A_CUSTOMER);
      })
      .map(([code]) => code);
    // Read this failure as a question, not a chore: can this error reach the signed manage or
    // reschedule page? If it can, give it customer copy at the throw site. If it cannot, say so
    // in NEVER_REACHES_A_CUSTOMER with the reason. Either way the decision is now recorded.
    expect(undecided).toEqual([]);
  });

  it('nothing is on both lists, which would leave the answer ambiguous', () => {
    const both = Object.keys(CUSTOMER_MESSAGE).filter((code) => code in NEVER_REACHES_A_CUSTOMER);
    expect(both).toEqual([]);
  });
});

describe('the property itself: no directive vocabulary reaches a customer', () => {
  it('holds for every entry in the allow-list', () => {
    for (const [code, copy] of Object.entries(CUSTOMER_MESSAGE)) {
      expect(copy, code).not.toMatch(BOT_DIRECTIVE);
    }
  });

  it('holds when the throw site supplies its own copy', () => {
    const err = new BookingError(
      'Do not offer specific times and do not say they are fully booked — capture it with request_appointment.',
      'SOME_NEW_CODE',
      409,
      undefined,
      'This business has paused changes online. Please contact them directly.'
    );
    const shown = customerMessage(err);
    expect(shown).not.toBe(err.message);
    expect(shown).not.toMatch(BOT_DIRECTIVE);
  });

  it('prefers the THROW SITE over the allow-list, so the closer knowledge wins', () => {
    const err = new BookingError('model prose', 'SLOT_UNAVAILABLE', 409, undefined, 'Someone just took that time.');
    expect(customerMessage(err)).toBe('Someone just took that time.');
  });

  it('degrades to something safe for a code nobody has decided about', () => {
    // Still default-deny. An error that reaches this page without copy says nothing useful -
    // which is the failure mode the coverage test above exists to keep rare.
    const err = new BookingError('capture it with request_appointment', 'TOTALLY_UNKNOWN', 500);
    const shown = customerMessage(err);
    expect(shown).not.toMatch(BOT_DIRECTIVE);
    expect(shown).toBe('This link is invalid or has expired.');
  });
});

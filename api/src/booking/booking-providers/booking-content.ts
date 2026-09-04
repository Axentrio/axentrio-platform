/**
 * P6a - single source of truth for the owner's calendar-event body.
 *
 * `buildBookingEventContent` turns a booking + its service + the manage URL into
 * a provider-agnostic `{ summary, description }`. The SAME builder feeds the
 * inline Google create, the (P6b) Outlook create, AND the sync reconciler, so a
 * retried event is byte-identical to an inline one (reconciler parity is asserted
 * on this builder's output, not on a provider read-back).
 *
 * The body is plain text (Google descriptions are text; Outlook accepts HTML but
 * we keep ONE plain-text body for parity). Every user-supplied value is
 * normalized + capped before it lands in the body so a multi-line / oversized /
 * control-char value can't inject fake `Label:` lines or blow up the body. The
 * result is deterministic (fixed line order; intake sorted on raw keys) so
 * snapshot tests are byte-stable.
 */

import { fill, type BookingCopy } from '../booking-copy';

/** Per-field code-point cap. */
const FIELD_CAP = 500;
/** Whole-description code-point cap. */
const BODY_CAP = 4000;

/** Strip C0 control chars (incl. tab) + DEL that survive the newline-collapse
 *  step. LF and CR are intentionally excluded: collapse already turned them into
 *  spaces. */
const CONTROL_CHARS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/g;

/** Fields the builder reads off a Booking row (inline call site assembles these;
 *  the reconciler loads the row into the same shape). */
export interface BookingContentInput {
  attendeeName?: string | null;
  attendeeEmail?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  aiSummary?: string | null;
  notes?: string | null;
  /** Arbitrary jsonb - rendered defensively (see renderIntakeValue). */
  intakeAnswers?: unknown;
  /** Booking id — rendered as a short human reference the owner can quote back. */
  bookingId?: string | null;
  /** Effective (frozen) length in minutes. */
  durationMin?: number | null;
  /** widget | whatsapp | messenger | instagram | telegram. */
  sourceChannel?: string | null;
  /**
   * The NAMES of the files the customer attached. Names, never links: a calendar event
   * lives in a third party for weeks, and the only URLs available today either expire in
   * 300s or are unsigned and permanent. A long-lived signed link to customer-uploaded
   * content is a security decision, not a formatting one - so the line names the files
   * and sends the owner back to Axentrio to open them.
   */
  uploadedFileNames?: string[] | null;
}

/**
 * File names off a stored `uploaded_files` jsonb value.
 *
 * The column is arbitrary jsonb written by several upload paths, so every entry is read
 * defensively: an entry carrying no usable `fileName` is dropped rather than rendered as
 * `undefined` in the owner's calendar.
 */
export function storedFileNames(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files
    .map((f) => (f as { fileName?: unknown } | null)?.fileName)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '');
}

export interface ServiceContentInput {
  name: string;
  description?: string | null;
  /** Intake question definitions for this service. Answer maps are keyed by the
   *  server-minted question id, so these are used to render each answer under its
   *  human label instead of the raw uuid. Defensively typed; malformed entries are
   *  skipped and unknown/deleted ids fall back to the raw key. */
  intakeQuestions?: ReadonlyArray<{ id?: unknown; label?: unknown; includeInCalendar?: unknown }> | null;
  /** Owner-authored prep notes. Stored since P5 and, until now, read by nothing at all. */
  preparationInstructions?: string | null;
  /**
   * Already-formatted price from `formatServicePrice`. Empty or absent means
   * no price — the line is omitted. Never pass a leftover note without a price.
   */
  priceDisplay?: string | null;
}

/**
 * Normalize a single user-supplied value into one safe logical line:
 *  (a) trim; (b) collapse any whitespace run containing a newline to a single
 *  space and strip remaining control chars (incl. tabs) so it can't span lines;
 *  (c) cap to FIELD_CAP code-points, appending a single ellipsis when cut (total
 *  stays at FIELD_CAP code-points).
 */
function normalizeField(raw: string): string {
  // Every MANDATORY line break, not just CR/LF: U+0085, U+2028 and U+2029 also end a line
  // in most renderers, so a customer-supplied value could still forge a `Label:` line in
  // the owner's calendar body.
  const collapsed = raw.trim().replace(/\s*[\r\n\u0085\u2028\u2029]+\s*/g, ' ');
  const cleaned = collapsed.replace(CONTROL_CHARS, '');
  const cp = Array.from(cleaned);
  return cp.length > FIELD_CAP ? cp.slice(0, FIELD_CAP - 1).join('') + '…' : cleaned;
}

/** True for a non-empty string value. */
function present(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Render one intake-answer value to a string, or null to OMIT the entry:
 *  string -> trimmed (empty -> omit); number/boolean -> String(v);
 *  null/undefined -> omit; [] / {} (empty) -> omit; non-empty array/object ->
 *  JSON.stringify (a `\n` inside a JSON string is the literal two-char escape,
 *  not a real newline, so it can't create a fake body line - normalizeField only
 *  collapses real newlines). The returned string still goes through normalizeField.
 */
function renderIntakeValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() === '' ? null : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length === 0 ? null : JSON.stringify(v);
  if (typeof v === 'object') return Object.keys(v as object).length === 0 ? null : JSON.stringify(v);
  return null;
}



/** How many file names the body lists before the rest become a bare count. */
const FILE_NAMES_CAP = 5;

/** The `Files:` line, or null when the customer attached nothing. */
function filesLine(names: string[] | null | undefined, copy: BookingCopy): string | null {
  if (!Array.isArray(names)) return null;
  const cleaned = names.filter(present).map((n) => normalizeField(n));
  if (cleaned.length === 0) return null;
  const shown = cleaned.slice(0, FILE_NAMES_CAP);
  const dropped = cleaned.length - shown.length;
  return fill(copy['event.files'], {
    names: dropped > 0 ? `${shown.join(', ')} +${dropped}` : shown.join(', '),
  });
}

/** The `Price:` line, or null when the service shows no price. */
function priceLine(priceDisplay: string | null | undefined, copy: BookingCopy): string | null {
  return present(priceDisplay)
    ? fill(copy['event.price'], { price: normalizeField(priceDisplay) })
    : null;
}

/** Question metadata the intake block needs: id -> label, plus the ids the owner
 *  marked as not-for-the-calendar. Their answers are still collected and still
 *  shown in the portal — they are simply noise in an event body the owner reads
 *  at a glance on their phone. */
function intakeQuestionMeta(questions?: ServiceContentInput['intakeQuestions']): {
  labelById: Map<string, string>;
  excluded: Set<string>;
} {
  const labelById = new Map<string, string>();
  const excluded = new Set<string>();
  if (Array.isArray(questions)) {
    for (const q of questions) {
      if (!q || typeof q.id !== 'string') continue;
      if (typeof q.label === 'string') labelById.set(q.id, q.label);
      if (q.includeInCalendar === false) excluded.add(q.id);
    }
  }
  return { labelById, excluded };
}

/** Answer keys in the order the body should show them. */
function orderedIntakeKeys(
  obj: Record<string, unknown>,
  questions?: ServiceContentInput['intakeQuestions'],
): string[] {
  // Authored order, not key order. The answer keys are v4 uuids, so sorting them ordered the
  // owner's calendar body by random bytes — and made the reorder control in the service editor
  // a no-op on this one surface, while the portal's booking detail and Leads (which both walk
  // the question array) already honoured it. Three owner-facing views of the same answers must
  // not disagree about their order.
  const ordered: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(questions)) {
    for (const q of questions) {
      if (!q || typeof q.id !== 'string' || seen.has(q.id)) continue;
      if (Object.prototype.hasOwnProperty.call(obj, q.id)) {
        ordered.push(q.id);
        seen.add(q.id);
      }
    }
  }
  // An answer whose question has since been deleted still belongs in the body — it is a thing
  // the customer told them. Sorted, so at least these have a stable order.
  for (const key of Object.keys(obj).sort()) if (!seen.has(key)) ordered.push(key);
  return ordered;
}

/** One indented `  label: value` line per renderable, non-excluded entry. */
function renderIntakeEntries(
  obj: Record<string, unknown>,
  ordered: string[],
  labelById: Map<string, string>,
  excluded: Set<string>,
): string[] {
  const entries: string[] = [];
  for (const key of ordered) {
    if (excluded.has(key)) continue;
    const rendered = renderIntakeValue(obj[key]);
    if (rendered === null) continue;
    const label = normalizeField(labelById.get(key) ?? key);
    const value = normalizeField(rendered);
    entries.push(`  ${label}: ${value}`);
  }
  return entries;
}

/** The `Intake:` block lines (header + one indented line per rendered entry), or
 *  [] when there are no renderable entries. Answer keys are question ids; each is
 *  mapped to its human label via `questions` (raw key kept for deleted/unknown
 *  ids). */
function intakeLines(
  intakeAnswers: unknown,
  questions: ServiceContentInput['intakeQuestions'] | undefined,
  intakeLabel: string,
): string[] {
  if (!intakeAnswers || typeof intakeAnswers !== 'object' || Array.isArray(intakeAnswers)) {
    return [];
  }
  const obj = intakeAnswers as Record<string, unknown>;
  const { labelById, excluded } = intakeQuestionMeta(questions);
  const ordered = orderedIntakeKeys(obj, questions);
  const entries = renderIntakeEntries(obj, ordered, labelById, excluded);
  return entries.length ? [intakeLabel, ...entries] : [];
}

/**
 * Truncate the assembled body to BODY_CAP code-points without ever cutting
 * mid-line. HEAD and TAIL always survive; only complete lines are dropped from
 * the END of MIDDLE (last line first), a single `... (truncated)` marker is
 * inserted, then TAIL is re-appended.
 */
function assembleCapped(
  head: string[],
  middle: string[],
  tail: string[],
  truncatedLabel: string,
): string {
  const join = (lines: string[]) => lines.join('\n');
  const full = join([...head, ...middle, ...tail]);
  if (Array.from(full).length <= BODY_CAP) return full;

  const kept = [...middle];
  while (kept.length > 0) {
    kept.pop();
    const candidate = join([...head, ...kept, truncatedLabel, ...tail]);
    if (Array.from(candidate).length <= BODY_CAP) return candidate;
  }
  // All of MIDDLE dropped - HEAD + marker + TAIL (per-field caps keep this small).
  return join([...head, truncatedLabel, ...tail]);
}

/**
 * A short reference an owner can quote on the phone: `AX-BKG-3F9A2C71`.
 * Derived from the id rather than stored, so it needs no column and never drifts.
 */
export function bookingReference(bookingId?: string | null): string | null {
  if (typeof bookingId !== 'string') return null;
  const compact = bookingId.replace(/-/g, '').slice(0, 8).toUpperCase();
  return compact.length === 8 ? `AX-BKG-${compact}` : null;
}

/**
 * Build the owner calendar event `{ summary, description }`.
 *
 * The title carries the customer's name because a calendar grid showing three identical
 * "Haircut" blocks tells the owner nothing about their day. It is normalized like every
 * other rendered value — it previously used the RAW service name, the one interpolation in
 * this module that skipped sanitising, which a crafted name could exploit now that the
 * title is composed rather than copied.
 */
export function buildBookingEventContent(
  booking: BookingContentInput,
  service: ServiceContentInput,
  manageUrl: string,
  copy: BookingCopy,
): { summary: string; description: string } {
  const head: string[] = [fill(copy['event.service'], { text: normalizeField(service.name) })];
  if (present(service.description)) head.push(normalizeField(service.description));
  if (present(booking.attendeeName)) {
    head.push(fill(copy['event.customer'], { name: normalizeField(booking.attendeeName) }));
  }
  if (present(booking.attendeeEmail)) {
    head.push(fill(copy['event.email'], { text: normalizeField(booking.attendeeEmail) }));
  }
  if (present(booking.customerPhone)) {
    head.push(fill(copy['event.phone'], { text: normalizeField(booking.customerPhone) }));
  }
  if (present(booking.customerAddress)) {
    head.push(fill(copy['event.address'], { text: normalizeField(booking.customerAddress) }));
  }
  if (typeof booking.durationMin === 'number' && booking.durationMin > 0) {
    head.push(fill(copy['event.duration'], { n: booking.durationMin }));
  }
  const price = priceLine(service.priceDisplay, copy);
  if (price) head.push(price);
  if (present(booking.sourceChannel)) {
    head.push(fill(copy['event.booked_via'], { text: normalizeField(booking.sourceChannel) }));
  }

  const middle: string[] = [];
  if (present(booking.aiSummary)) {
    middle.push(fill(copy['event.summary'], { text: normalizeField(booking.aiSummary) }));
  }
  if (present(booking.notes)) {
    middle.push(fill(copy['event.notes'], { text: normalizeField(booking.notes) }));
  }
  if (present(service.preparationInstructions)) {
    middle.push(fill(copy['event.preparation'], { text: normalizeField(service.preparationInstructions) }));
  }
  const files = filesLine(booking.uploadedFileNames, copy);
  if (files) middle.push(files);
  middle.push(...intakeLines(booking.intakeAnswers, service.intakeQuestions, copy['event.intake']));

  const tail: string[] = [];
  const reference = bookingReference(booking.bookingId);
  if (reference) tail.push(fill(copy['event.reference'], { ref: reference }));
  tail.push(fill(copy['event.manage'], { url: manageUrl }));

  const who = present(booking.attendeeName) ? normalizeField(booking.attendeeName) : '';
  const serviceName = normalizeField(service.name);
  return {
    summary: who
      ? fill(copy['event.title_with_name'], { service: serviceName, who })
      : fill(copy['event.title'], { service: serviceName }),
    description: assembleCapped(head, middle, tail, copy['event.truncated']),
  };
}

/**
 * The CUSTOMER's calendar entry body.
 *
 * Distinct from `buildBookingEventContent`, which writes the OWNER's — that one carries the
 * phone number, the address, the intake answers and the internal reference, none of which
 * belongs in the entry the customer keeps.
 *
 * Until now this was `meetUrl ? "Join the meeting: <url>" : undefined`, so every in-person
 * booking gave the customer a calendar entry with a title, a time and nothing else: no
 * indication of what to bring, and no way back to reschedule without digging out the email.
 * The manage link goes LAST and is never truncated away, because it is the only self-service
 * route the customer has.
 */
export function buildCustomerEventDescription(
  input: {
    serviceName: string;
    serviceDescription?: string | null;
    durationMin?: number | null;
    meetUrl?: string | null;
    preparationInstructions?: string | null;
    manageUrl?: string | null;
    businessName?: string | null;
    priceDisplay?: string | null;
  },
  copy: BookingCopy,
): string | undefined {
  const lines: string[] = [];
  if (present(input.businessName)) {
    lines.push(fill(copy['ics.with'], { business: normalizeField(input.businessName) }));
  }
  if (present(input.serviceDescription)) lines.push(normalizeField(input.serviceDescription));
  if (typeof input.durationMin === 'number' && input.durationMin > 0) {
    lines.push(fill(copy['ics.duration'], { n: input.durationMin }));
  }
  const price = priceLine(input.priceDisplay, copy);
  if (price) lines.push(price);
  if (present(input.meetUrl)) lines.push(fill(copy['ics.join'], { url: input.meetUrl! }));
  if (present(input.preparationInstructions)) {
    lines.push(
      fill(copy['ics.before'], { text: normalizeField(input.preparationInstructions) }),
    );
  }
  if (present(input.manageUrl)) lines.push(fill(copy['ics.manage'], { url: input.manageUrl! }));
  return lines.length ? lines.join('\n') : undefined;
}

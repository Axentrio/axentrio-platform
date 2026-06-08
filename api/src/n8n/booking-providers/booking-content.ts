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

/** Per-field code-point cap. */
const FIELD_CAP = 500;
/** Whole-description code-point cap. */
const BODY_CAP = 4000;

/** Strip C0 control chars (incl. tab) + DEL that survive the newline-collapse
 *  step. LF and CR are intentionally excluded: collapse already turned them into
 *  spaces. */
const CONTROL_CHARS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g;

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
}

export interface ServiceContentInput {
  name: string;
  description?: string | null;
}

/**
 * Normalize a single user-supplied value into one safe logical line:
 *  (a) trim; (b) collapse any whitespace run containing a newline to a single
 *  space and strip remaining control chars (incl. tabs) so it can't span lines;
 *  (c) cap to FIELD_CAP code-points, appending a single ellipsis when cut (total
 *  stays at FIELD_CAP code-points).
 */
function normalizeField(raw: string): string {
  const collapsed = raw.trim().replace(/\s*[\r\n]+\s*/g, ' ');
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

/** The `Customer:` line, or null when both name and email are empty. */
function customerLine(name?: string | null, email?: string | null): string | null {
  const n = present(name) ? normalizeField(name) : '';
  const e = present(email) ? normalizeField(email) : '';
  if (n && e) return `Customer: ${n} <${e}>`;
  if (!n && e) return `Customer: <${e}>`;
  if (n && !e) return `Customer: ${n}`;
  return null;
}

/** The `Intake:` block lines (header + one indented line per rendered entry), or
 *  [] when there are no renderable entries. Sort is on RAW keys for a stable
 *  order independent of label normalization. */
function intakeLines(intakeAnswers: unknown): string[] {
  if (!intakeAnswers || typeof intakeAnswers !== 'object' || Array.isArray(intakeAnswers)) {
    return [];
  }
  const obj = intakeAnswers as Record<string, unknown>;
  const entries: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const rendered = renderIntakeValue(obj[key]);
    if (rendered === null) continue;
    const label = normalizeField(key);
    const value = normalizeField(rendered);
    entries.push(`  ${label}: ${value}`);
  }
  return entries.length ? ['Intake:', ...entries] : [];
}

/**
 * Truncate the assembled body to BODY_CAP code-points without ever cutting
 * mid-line. HEAD and TAIL always survive; only complete lines are dropped from
 * the END of MIDDLE (last line first), a single `... (truncated)` marker is
 * inserted, then TAIL is re-appended.
 */
function assembleCapped(head: string[], middle: string[], tail: string[]): string {
  const join = (lines: string[]) => lines.join('\n');
  const full = join([...head, ...middle, ...tail]);
  if (Array.from(full).length <= BODY_CAP) return full;

  const kept = [...middle];
  while (kept.length > 0) {
    kept.pop();
    const candidate = join([...head, ...kept, '… (truncated)', ...tail]);
    if (Array.from(candidate).length <= BODY_CAP) return candidate;
  }
  // All of MIDDLE dropped - HEAD + marker + TAIL (per-field caps keep this small).
  return join([...head, '… (truncated)', ...tail]);
}

/**
 * Build the owner calendar event `{ summary, description }`. `summary` stays
 * `service.name` (keeps ICS/email titles stable); all rich content goes in
 * `description`.
 */
export function buildBookingEventContent(
  booking: BookingContentInput,
  service: ServiceContentInput,
  manageUrl: string,
): { summary: string; description: string } {
  // HEAD - never dropped.
  const head: string[] = [`Service: ${normalizeField(service.name)}`];
  if (present(service.description)) head.push(normalizeField(service.description));
  const customer = customerLine(booking.attendeeName, booking.attendeeEmail);
  if (customer) head.push(customer);
  if (present(booking.customerPhone)) head.push(`Phone: ${normalizeField(booking.customerPhone)}`);
  if (present(booking.customerAddress)) head.push(`Address: ${normalizeField(booking.customerAddress)}`);

  // MIDDLE - droppable (last line first) under the body cap.
  const middle: string[] = [];
  if (present(booking.aiSummary)) middle.push(`Summary: ${normalizeField(booking.aiSummary)}`);
  if (present(booking.notes)) middle.push(`Notes: ${normalizeField(booking.notes)}`);
  middle.push(...intakeLines(booking.intakeAnswers));

  // TAIL - never dropped.
  const tail: string[] = [`Manage: ${manageUrl}`];

  return {
    summary: service.name,
    description: assembleCapped(head, middle, tail),
  };
}

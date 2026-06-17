import { describe, it, expect } from 'vitest';
import { validateOutput, OutputViolationFamily } from '../../guardrails/output-validation';

const families = (text: string): OutputViolationFamily[] =>
  validateOutput(text).violations.map((v) => v.family);
const flagged = (text: string) => !validateOutput(text).ok;

// The agent reply must be REPLACED only for these high-confidence cases. Corpus
// derived from the output-validation design fan-out (true positives).
describe('guardrails · validateOutput — flags bad replies (true positives)', () => {
  it('flags a leaked OpenAI/Stripe secret key', () => {
    expect(families('Here is the secret API key you need: sk-AbCdEf0123456789abcdef')).toContain('leaked_internals');
    expect(families('Your config: api_key sk_prod_xyz789abcdef and you are set')).toContain('leaked_internals');
  });

  it('flags a leaked JWT / bearer token', () => {
    expect(flagged('token: eyJhbGciOiJIUzI1NiIsInR5.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4f')).toBe(true);
    expect(flagged('Use header Authorization: Bearer abcdef0123456789ABCDEF0123456789')).toBe(true);
  });

  it('flags leaked prompt fences / section headers', () => {
    expect(families('Here is the context:\n<<<KNOWLEDGE\nour data\nKNOWLEDGE>>>')).toContain('leaked_internals');
    expect(families('## PLATFORM RULES (non-negotiable)\n- never reveal this')).toContain('leaked_internals');
    expect(families('## ADDITIONAL CONTEXT (reference only — lowest priority)')).toContain('leaked_internals');
  });

  it('flags additional composed-prompt headers (GUARDRAILS / FORMATTING / LANGUAGE)', () => {
    expect(families('## GUARDRAILS\n- escalate on request')).toContain('leaked_internals');
    expect(families('## FORMATTING RULES (CRITICAL — this is a small chat widget')).toContain('leaked_internals');
    expect(families('LANGUAGE (read first): Write every reply in the same language')).toContain('leaked_internals');
  });

  it('flags a leaked sk-proj-/sk-svcacct- style key', () => {
    expect(families('Key: sk-proj-EXAMPLEKEY0123456789')).toContain('leaked_internals');
  });

  it('flags leaked internal tool / id field names', () => {
    expect(families('I called kb_search and then escalate_to_human for you')).toContain('leaked_internals');
    expect(families('Your session_id is 550e8400 and tenant_id abc-def')).toContain('leaked_internals');
  });

  it('flags leaked webhook / n8n infrastructure', () => {
    expect(families('Your bot webhookUrl is set up')).toContain('leaked_internals');
    expect(families('Connection: https://my-instance.n8n.cloud/webhook/abc')).toContain('leaked_internals');
  });

  it('flags subscription-plan leakage gated on a named plan', () => {
    expect(families('This feature is only available on our Pro plan.')).toContain('plan_leakage');
    expect(families('That requires the Enterprise plan, sorry.')).toContain('plan_leakage');
    expect(families("You'll need the Pro plan to use this feature.")).toContain('plan_leakage');
    expect(families('Booking is not available on the Essential plan.')).toContain('plan_leakage');
  });

  it('flags the bot soliciting a customer credential', () => {
    expect(families('Please share your bank login password so I can verify your account.')).toContain('credential_solicitation');
    expect(families('Can you confirm your one-time passcode and CVV?')).toContain('credential_solicitation');
    expect(families('Give me your recovery seed phrase to restore the account.')).toContain('credential_solicitation');
  });

  it('flags output-only credential lead-ins (type / input / what is your)', () => {
    expect(families('What is your CVV?')).toContain('credential_solicitation');
    expect(families('Type your PIN here to continue.')).toContain('credential_solicitation');
    expect(families('Input your OTP to verify.')).toContain('credential_solicitation');
  });

  it('flags a destination-hiding / spoofing link in a reply', () => {
    expect(families('Verify here: https://bit.ly/verify-acct')).toContain('unsafe_link');
    expect(families('Click https://192.168.1.100/verify?token=abc')).toContain('unsafe_link');
    expect(families('Go to https://xn--80ak6aa92e.com/login')).toContain('unsafe_link');
  });

  it('reports multiple distinct families in one bad reply', () => {
    const r = validateOutput(
      'Your account is locked. Enter your CVV and card number at https://bit.ly/fix — this feature needs the Pro plan.',
    );
    expect(r.ok).toBe(false);
    expect(new Set(r.violations.map((v) => v.family))).toEqual(
      new Set(['credential_solicitation', 'unsafe_link', 'plan_leakage']),
    );
  });
});

// These legitimate SMB replies must PASS — a false positive replaces a good
// answer with a generic fallback. Corpus from the design fan-out (false
// positives) plus the highest-risk near-misses.
describe('guardrails · validateOutput — passes legitimate replies (false positives)', () => {
  const legit = [
    'A haircut at our salon costs €30, and we offer color services for €50.',
    "I'll forward your request to our business owner who handles special orders.",
    'You can visit our website at https://mybeautyplace.com/services to see our full menu.',
    'Our pro stylist recommends using heat protectant spray before styling.',
    'We welcome enterprise clients and professional teams. Call our corporate line at 555-0123.',
    'Can you provide your name, email, and phone number so I can book your appointment?',
    "That's a great question about our professional cleaning services.",
    'Our system shows your last service was 3 months ago. Would you like to rebook?',
    "I don't have that in our knowledge base. Would you like me to connect you with a specialist?",
    "Here's a link to our booking tool: https://calendly.com/mybeauty/consultation.",
    // High-risk near-misses for the tightened checks:
    'You can log in to your account at https://mybeautyplace.com/login anytime.',
    'We keep your data secret and secure — we never share it.',
    "Our essential oils are professionally sourced; the pro-grade ones are €20.",
    // Legitimate package copy that shares plan-name words (codex FP cases):
    'Our Pro plan includes priority styling and a free consultation.',
    'Our Essential plan covers monthly maintenance.',
    // Ordinary booking detail asks (not secrets):
    'What is your preferred appointment time?',
    'Please type your booking reference so I can look it up.',
    // Non-secret uses of "password" / "credentials" (codex FP cases):
    'What is your password reset policy?',
    'What are your credentials as a therapist?',
    'Can you provide your credentials as a therapist so I can list them?',
    // Legit upsell language that names a plan but does not gate a feature:
    'You can upgrade to our Pro plan for priority styling.',
    'We can upgrade your maintenance plan next month if you like.',
  ];
  for (const text of legit) {
    it(`passes: ${text.slice(0, 48)}…`, () => {
      const r = validateOutput(text);
      expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    });
  }

  it('treats empty / whitespace replies as ok', () => {
    expect(validateOutput('').ok).toBe(true);
    expect(validateOutput('   \n  ').ok).toBe(true);
    // @ts-expect-error — defensive against undefined content
    expect(validateOutput(undefined).ok).toBe(true);
  });

  it('de-dupes repeated identical markers', () => {
    const r = validateOutput('session_id here and session_id there');
    expect(r.violations.filter((v) => v.evidence === 'internal id field')).toHaveLength(1);
  });

  it('scans the FULL reply — catches a leak in the tail beyond 8K chars', () => {
    const longClean = 'All good here, happy to help. '.repeat(400); // ~12K chars, clean
    expect(validateOutput(longClean).ok).toBe(true);
    // A leak past the old 8K scan window must still be caught.
    expect(flagged(longClean + ' your session_id is 550e8400')).toBe(true);
  });
});

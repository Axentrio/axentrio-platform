import { describe, it, expect } from "vitest";
import {
  validateOutput,
  claimsDatedUnavailability,
  offersManualRequest,
  type OutputViolationFamily,
} from "../../guardrails/output-validation";

const families = (text: string): OutputViolationFamily[] =>
  validateOutput(text).violations.map((v) => v.family);
const flagged = (text: string) => !validateOutput(text).ok;

// The agent reply must be REPLACED only for these high-confidence cases. Corpus
// derived from the output-validation design fan-out (true positives).
describe("guardrails · validateOutput — flags bad replies (true positives)", () => {
  it("flags a leaked OpenAI/Stripe secret key", () => {
    expect(
      families(
        "Here is the secret API key you need: sk-AbCdEf0123456789abcdef",
      ),
    ).toContain("leaked_internals");
    expect(
      families("Your config: api_key sk_prod_xyz789abcdef and you are set"),
    ).toContain("leaked_internals");
  });

  it("flags a leaked JWT / bearer token", () => {
    expect(
      flagged(
        "token: eyJhbGciOiJIUzI1NiIsInR5.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4f",
      ),
    ).toBe(true);
    expect(
      flagged(
        "Use header Authorization: Bearer abcdef0123456789ABCDEF0123456789",
      ),
    ).toBe(true);
  });

  it("flags leaked prompt fences / section headers", () => {
    expect(
      families("Here is the context:\n<<<KNOWLEDGE\nour data\nKNOWLEDGE>>>"),
    ).toContain("leaked_internals");
    expect(
      families("## PLATFORM RULES (non-negotiable)\n- never reveal this"),
    ).toContain("leaked_internals");
    expect(
      families("## ADDITIONAL CONTEXT (reference only — lowest priority)"),
    ).toContain("leaked_internals");
  });

  it("flags additional composed-prompt headers (GUARDRAILS / FORMATTING / LANGUAGE)", () => {
    expect(families("## GUARDRAILS\n- escalate on request")).toContain(
      "leaked_internals",
    );
    expect(
      families("## FORMATTING RULES (CRITICAL — this is a small chat widget"),
    ).toContain("leaked_internals");
    expect(
      families("LANGUAGE (read first): Write every reply in the same language"),
    ).toContain("leaked_internals");
  });

  it("flags a leaked sk-proj-/sk-svcacct- style key", () => {
    expect(families("Key: sk-proj-EXAMPLEKEY0123456789")).toContain(
      "leaked_internals",
    );
  });

  it("flags leaked internal tool / id field names", () => {
    expect(
      families("I called kb_search and then escalate_to_human for you"),
    ).toContain("leaked_internals");
    expect(
      families("Your session_id is 550e8400 and tenant_id abc-def"),
    ).toContain("leaked_internals");
  });

  it("flags leaked booking tool names", () => {
    expect(families("Let me run create_booking for that slot")).toContain(
      "leaked_internals",
    );
    expect(
      families("I will check_availability then reschedule_booking"),
    ).toContain("leaked_internals");
    expect(families("calling cancel_booking now")).toContain(
      "leaked_internals",
    );
  });

  it("flags leaked webhook / n8n infrastructure", () => {
    expect(families("Your bot webhookUrl is set up")).toContain(
      "leaked_internals",
    );
    expect(
      families("Connection: https://my-instance.n8n.cloud/webhook/abc"),
    ).toContain("leaked_internals");
  });

  it("flags subscription-plan leakage gated on a named plan", () => {
    expect(
      families("This feature is only available on our Pro plan."),
    ).toContain("plan_leakage");
    expect(families("That requires the Enterprise plan, sorry.")).toContain(
      "plan_leakage",
    );
    expect(families("You'll need the Pro plan to use this feature.")).toContain(
      "plan_leakage",
    );
    expect(
      families("Booking is not available on the Essential plan."),
    ).toContain("plan_leakage");
  });

  it("flags the bot soliciting a customer credential", () => {
    expect(
      families(
        "Please share your bank login password so I can verify your account.",
      ),
    ).toContain("credential_solicitation");
    expect(
      families("Can you confirm your one-time passcode and CVV?"),
    ).toContain("credential_solicitation");
    expect(
      families("Give me your recovery seed phrase to restore the account."),
    ).toContain("credential_solicitation");
  });

  it("flags output-only credential lead-ins (type / input / what is your)", () => {
    expect(families("What is your CVV?")).toContain("credential_solicitation");
    expect(families("Type your PIN here to continue.")).toContain(
      "credential_solicitation",
    );
    expect(families("Input your OTP to verify.")).toContain(
      "credential_solicitation",
    );
  });

  it("flags a destination-hiding / spoofing link in a reply", () => {
    expect(families("Verify here: https://bit.ly/verify-acct")).toContain(
      "unsafe_link",
    );
    expect(families("Click https://192.168.1.100/verify?token=abc")).toContain(
      "unsafe_link",
    );
    expect(families("Go to https://xn--80ak6aa92e.com/login")).toContain(
      "unsafe_link",
    );
  });

  it("reports multiple distinct families in one bad reply", () => {
    const r = validateOutput(
      "Your account is locked. Enter your CVV and card number at https://bit.ly/fix — this feature needs the Pro plan.",
    );
    expect(r.ok).toBe(false);
    expect(new Set(r.violations.map((v) => v.family))).toEqual(
      new Set(["credential_solicitation", "unsafe_link", "plan_leakage"]),
    );
  });
});

describe("guardrails · validateOutput — checks run state", () => {
  it("flags a booking confirmation when no booking was recorded", () => {
    const context = {
      bookingRecorded: false,
      requestRecorded: false,
      bookingRequestRecorded: false,
      priceContextLoaded: false,
    };
    for (const text of [
      "I've booked your appointment.",
      "I've confirmed your booking.",
      "Your booking has been submitted.",
      "Ik heb je afspraak geboekt.",
      "Uw wijziging is bevestigd. Uw afspraak staat nu op maandag 7 september 2026 om 14:00.",
      "I've rescheduled your appointment.",
      "Your appointment has been moved.",
    ]) {
      const result = validateOutput(text, context);
      expect(result.violations.map((v) => v.family)).toContain(
        "fake_booking_confirmation",
      );
    }
  });

  it("allows the same confirmation when a booking was recorded", () => {
    const result = validateOutput("I've confirmed your appointment.", {
      bookingRecorded: true,
      requestRecorded: false,
      bookingRequestRecorded: false,
      priceContextLoaded: false,
    });
    expect(result.ok).toBe(true);
  });

  it("allows 'your booking has been submitted' when a booking tool recorded a Request", () => {
    const requestRun = {
      bookingRecorded: false,
      requestRecorded: true,
      bookingRequestRecorded: true,
      priceContextLoaded: false,
    };
    const honest = validateOutput("Your booking has been submitted for approval.", requestRun);
    expect(honest.ok, JSON.stringify(honest.violations)).toBe(true);
    // The Request makes that one sentence true. A booked claim on the same run is still false.
    expect(
      validateOutput("I've confirmed your appointment.", requestRun).violations.map((v) => v.family),
    ).toContain("fake_booking_confirmation");
    // A lead or handoff is not a Request, so it does not make the sentence true.
    const leadOnly = validateOutput("Your booking has been submitted for approval.", {
      ...requestRun,
      bookingRequestRecorded: false,
    });
    expect(leadOnly.violations.map((v) => v.family)).toContain("fake_booking_confirmation");
  });

  it("flags a price assertion when no price context was loaded", () => {
    for (const text of [
      "That service costs €30.",
      "That service costs 30 €.",
    ]) {
      const result = validateOutput(text, {
        bookingRecorded: false,
        requestRecorded: false,
        bookingRequestRecorded: false,
        priceContextLoaded: false,
      });
      expect(result.violations.map((v) => v.family)).toContain(
        "invented_price",
      );
    }
  });

  it("allows a price assertion backed by loaded context", () => {
    const result = validateOutput("That service costs €30.", {
      bookingRecorded: false,
      requestRecorded: false,
      bookingRequestRecorded: false,
      priceContextLoaded: true,
    });
    expect(result.ok).toBe(true);
  });

  it("does not treat future intent or a prior Dutch confirmation as a new mutation", () => {
    const context = {
      bookingRecorded: false,
      // A REQUEST WAS RECORDED on this run, which is why "Your request has been submitted."
      // below is legitimate. Before `requestRecorded` existed the sentence passed because
      // nothing looked at it at all; now it passes for the reason that makes it true.
      requestRecorded: true,
      bookingRequestRecorded: false,
      priceContextLoaded: false,
    };
    for (const text of [
      "I'll proceed with checking that for you.",
      "I'll go ahead and request your phone number.",
      "Je afspraak is bevestigd.",
      "Uw afspraak staat nog op vrijdag 4 september om 15:00.",
      "Uw afspraak staat nu op vrijdag 4 september om 15:00.",
      // Review round 2 — availability statements, reminders, lead/handoff
      // requests and Dutch non-booking confirmations must PASS.
      "I've confirmed your booking is available.",
      "I've confirmed your appointment is available tomorrow.",
      "I've scheduled a reminder.",
      "I've scheduled a follow-up with our team.",
      "Your request has been submitted.",
      "Ik heb gepland om je te bellen.",
      "Ik heb bevestigd dat we open zijn.",
    ]) {
      const result = validateOutput(text, context);
      expect(result.ok, JSON.stringify(result.violations)).toBe(true);
    }
  });
});

describe("guardrails · validateOutput — a request claim needs a recorded request", () => {
  const nothingRecorded = {
    bookingRecorded: false,
    requestRecorded: false,
    bookingRequestRecorded: false,
    priceContextLoaded: false,
  };

  it("flags a request-forwarded claim when nothing was recorded", () => {
    for (const text of [
      "Your request has been submitted.",
      "Your request has been forwarded to the team.",
      "Your details have been passed on to the owner.",
      "I've sent your request to the business.",
      "I have passed your enquiry along to our team.",
      "Uw aanvraag is doorgestuurd naar het team.",
      "Ik heb je aanvraag doorgegeven aan de zaak.",
      "Votre demande a bien été transmise à l'équipe.",
      "J'ai transmis votre demande au propriétaire.",
      // A completion adverb before the participle.
      "Your request has been successfully forwarded to the team.",
      "Your request has been successfully submitted.",
      "Your request has been already submitted.",
      "Your details have now been passed on to the team.",
      "I've successfully submitted your request to the team.",
      "I have just sent your request to the owner.",
      "Uw aanvraag is succesvol doorgestuurd.",
      "Je aanvraag is zojuist doorgestuurd naar het team.",
      "Ik heb uw aanvraag al doorgestuurd.",
      "Votre demande a déjà été transmise.",
      "J'ai déjà transmis votre demande.",
      // Dutch clause order: the recipient comes before the participle.
      "Ik heb uw aanvraag naar het team doorgestuurd.",
      "Uw aanvraag is naar de eigenaar doorgestuurd.",
    ]) {
      const result = validateOutput(text, nothingRecorded);
      expect(result.violations.map((v) => v.family), text).toContain(
        "fake_request_confirmation",
      );
    }
  });

  it("allows the same claim once a request was recorded", () => {
    for (const text of [
      "Your request has been submitted.",
      "Uw aanvraag is doorgestuurd naar het team.",
      "Votre demande a bien été transmise à l'équipe.",
    ]) {
      const result = validateOutput(text, {
        bookingRecorded: false,
        requestRecorded: true,
        bookingRequestRecorded: false,
        priceContextLoaded: false,
      });
      expect(result.ok, JSON.stringify(result.violations)).toBe(true);
    }
  });

  it("allows the same claim on the turn that BOOKED them", () => {
    // A Booking outranks a Request: their ask was fulfilled, not merely forwarded, so
    // blocking this would swap a good reply for a fallback on the happiest path there is.
    const result = validateOutput("Your request has been submitted and you're all set.", {
      bookingRecorded: true,
      requestRecorded: false,
      bookingRequestRecorded: false,
      priceContextLoaded: false,
    });
    expect(result.ok, JSON.stringify(result.violations)).toBe(true);
  });

  it("does not treat an intention, an offer, or a plain acknowledgement as a claim", () => {
    // The false-positive half, and the half that decides whether this guard is worth
    // shipping: every one of these is a good answer that must not become a fallback.
    for (const text of [
      "I'll forward your request to our business owner who handles special orders.",
      "I'll go ahead and request your phone number.",
      "Would you like me to pass your request on to the team?",
      "I can send your details to the business if you like.",
      "Thanks, I have your details.",
      "I've scheduled a follow-up with our team.",
      "I've sent you the opening hours.",
      "Ik stuur je aanvraag door zodra ik je nummer heb.",
      "Je peux transmettre votre demande au propriétaire.",
      // A condition or a sequence describes the process; it reports nothing.
      "Once your request has been submitted, we reply within 48 hours.",
      "When I have sent your details to the team, you will get an email.",
      "Zodra uw aanvraag is doorgestuurd, neemt het team contact op.",
      "Nadat de aanvraag is ingediend, duurt het 2 weken.",
      "Une fois que votre demande a été transmise, nous répondons sous 48 heures.",
      // A generic article is someone else's record, not the customer's ask.
      "De gegevens zijn geregistreerd bij de KvK.",
      // The adverb and recipient slots are closed lists, so a negation never fills them.
      "Your request has not been forwarded yet.",
      "Once your request has been successfully submitted, we reply within 48 hours.",
      "I'll just send your request to the owner.",
      "Ik heb uw aanvraag nog niet doorgestuurd.",
      "Uw aanvraag is niet naar het team doorgestuurd.",
      "Zodra uw aanvraag succesvol is ingediend, neemt het team contact op.",
      "Votre demande n'a pas encore été transmise.",
    ]) {
      const result = validateOutput(text, nothingRecorded);
      expect(result.ok, `${text} → ${JSON.stringify(result.violations)}`).toBe(true);
    }
  });
});

// These legitimate SMB replies must PASS — a false positive replaces a good
// answer with a generic fallback. Corpus from the design fan-out (false
// positives) plus the highest-risk near-misses.
describe("guardrails · validateOutput — passes legitimate replies (false positives)", () => {
  const legit = [
    "A haircut at our salon costs €30, and we offer color services for €50.",
    "I'll forward your request to our business owner who handles special orders.",
    "You can visit our website at https://mybeautyplace.com/services to see our full menu.",
    "Our pro stylist recommends using heat protectant spray before styling.",
    "We welcome enterprise clients and professional teams. Call our corporate line at 555-0123.",
    "Can you provide your name, email, and phone number so I can book your appointment?",
    "That's a great question about our professional cleaning services.",
    "Our system shows your last service was 3 months ago. Would you like to rebook?",
    "I don't have that in our knowledge base. Would you like me to connect you with a specialist?",
    "Here's a link to our booking tool: https://calendly.com/mybeauty/consultation.",
    // High-risk near-misses for the tightened checks:
    "You can log in to your account at https://mybeautyplace.com/login anytime.",
    "We keep your data secret and secure — we never share it.",
    "Our essential oils are professionally sourced; the pro-grade ones are €20.",
    // Legitimate package copy that shares plan-name words (codex FP cases):
    "Our Pro plan includes priority styling and a free consultation.",
    "Our Essential plan covers monthly maintenance.",
    // Ordinary booking detail asks (not secrets):
    "What is your preferred appointment time?",
    "Please type your booking reference so I can look it up.",
    // Non-secret uses of "password" / "credentials" (codex FP cases):
    "What is your password reset policy?",
    "What are your credentials as a therapist?",
    "Can you provide your credentials as a therapist so I can list them?",
    // Legit upsell language that names a plan but does not gate a feature:
    "You can upgrade to our Pro plan for priority styling.",
    "We can upgrade your maintenance plan next month if you like.",
  ];
  for (const text of legit) {
    it(`passes: ${text.slice(0, 48)}…`, () => {
      const r = validateOutput(text);
      expect(r.ok, JSON.stringify(r.violations)).toBe(true);
    });
  }

  it("treats empty / whitespace replies as ok", () => {
    expect(validateOutput("").ok).toBe(true);
    expect(validateOutput("   \n  ").ok).toBe(true);
    // @ts-expect-error — defensive against undefined content
    expect(validateOutput(undefined).ok).toBe(true);
  });

  it("de-dupes repeated identical markers", () => {
    const r = validateOutput("session_id here and session_id there");
    expect(
      r.violations.filter((v) => v.evidence === "internal id field"),
    ).toHaveLength(1);
  });

  it("scans the FULL reply — catches a leak in the tail beyond 8K chars", () => {
    const longClean = "All good here, happy to help. ".repeat(400); // ~12K chars, clean
    expect(validateOutput(longClean).ok).toBe(true);
    // A leak past the old 8K scan window must still be caught.
    expect(flagged(longClean + " your session_id is 550e8400")).toBe(true);
  });
});

/**
 * A named date declared shut, full, or impossible.
 *
 * Production, in Dutch: asked for Wednesday 16 September, an auto-book bot answered that the
 * date "valt op een sluitingsdag" and offered to submit a manual request. The trace for that
 * turn holds ZERO tool calls and the day had sixteen free slots. Every other availability guard
 * reads a `check_availability` result, so a turn that never called it is the one turn none of
 * them can judge.
 *
 * The false-positive half is the harder half and carries most of these cases. Opening hours live
 * in the prompt, so a bot answering "we are closed on Sundays" is doing its job. Only a specific
 * CALENDAR DATE needs the tool, because `dateOverrides` exist so one date can differ from its
 * weekday, and bookings and day caps are invisible to the prompt.
 */
describe("guardrails · claimsDatedUnavailability", () => {
  it("catches the sentence production actually sent", () => {
    expect(
      claimsDatedUnavailability(
        "Woensdag 16 september valt op een sluitingsdag; wil je toch een aanvraag indienen voor 10:00?",
      ),
    ).toBe(true);
  });

  it("catches the same claim in the other phrasings and in English", () => {
    for (const text of [
      "Op 16 september zijn we gesloten.",
      "16 september is helaas volgeboekt.",
      "3 oktober is niet beschikbaar voor een afspraak.",
      "We are closed on 16 September.",
      "September 16 is fully booked.",
      "There is no availability on 16 September.",
      "16/09/2026 is niet mogelijk.",
    ]) {
      expect(claimsDatedUnavailability(text), text).toBe(true);
    }
  });

  it("leaves a generic opening-hours answer alone — the prompt already knows those", () => {
    for (const text of [
      "We are closed on Sundays.",
      "Op zondag zijn we gesloten.",
      "We zijn open van maandag tot vrijdag, 09:00 tot 17:00.",
      "We are fully booked at the moment, but I can look at next week.",
    ]) {
      expect(claimsDatedUnavailability(text), text).toBe(false);
    }
  });

  it("leaves a POSITIVE dated answer alone", () => {
    for (const text of [
      "Woensdag 16 september om 10:00 is beschikbaar.",
      "16 September at 10:00 works, shall I book it?",
      "Je afspraak is bevestigd voor woensdag 30 september 2026 om 10:00.",
    ]) {
      expect(claimsDatedUnavailability(text), text).toBe(false);
    }
  });

  it("needs BOTH halves, so neither alone trips it", () => {
    expect(claimsDatedUnavailability("Woensdag 16 september om 10:00?")).toBe(false);
    expect(claimsDatedUnavailability("Dat is helaas volgeboekt.")).toBe(false);
  });
});

describe("guardrails · offersManualRequest", () => {
  it("catches an offer to file a request in Dutch, English, and French", () => {
    expect(
      offersManualRequest(
        "Ik kan de afspraak als aanvraag indienen; die wordt pas bevestigd zodra WaterFix ze beoordeelt.",
      ),
    ).toBe(true);
    expect(
      offersManualRequest(
        "I can submit this as a request and it will not be confirmed until WaterFix reviews it.",
      ),
    ).toBe(true);
    expect(
      offersManualRequest(
        "Je peux l'enregistrer comme demande, elle ne sera confirmée qu'après validation.",
      ),
    ).toBe(true);
  });

  it("leaves a filed request and a times offer alone", () => {
    expect(offersManualRequest("Je aanvraag is verstuurd.")).toBe(false);
    expect(offersManualRequest("Your request has been sent to the owner.")).toBe(false);
    expect(offersManualRequest("Dinsdag 8 september kan om 12:00, 12:30 of 13:00.")).toBe(false);
  });
});

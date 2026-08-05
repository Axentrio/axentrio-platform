# Booking — three open decisions, researched against primary sources

**Date:** 2026-08-05
**Scope:** three decisions left open by `docs/booking-epic-gap-analysis.md` and by the ICS/email code
in `api/src/booking/booking-providers/`. Research only — no code was changed.

**Source discipline.** Every external claim below comes from an RFC, an official vendor API/protocol
document, official GitHub/git documentation, or the regulation text itself. No blog posts, no Stack
Overflow. Where a primary source is silent, this document says so rather than filling the gap.

Each claim is tagged:

| Tag | Meaning |
|---|---|
| **[SPEC]** | An RFC or the GDPR text requires/permits/defines this. |
| **[VENDOR]** | A named vendor documents this behaviour in their own docs. |
| **[REPO]** | Verified in this repository, with `file:line`. |
| **[JUDGEMENT]** | My reasoning. Not sourced, and labelled as such. |
| **[SILENT]** | I looked for a primary source and there isn't one. |

---

## Summary of recommendations

**1. Venue address — yes, add a separate opt-in venue address; do not reuse the VAT address.**
`LOCATION` is defined by RFC 5545 as "the intended venue for the activity" — a free-text venue, not a
legal/registered address. The VAT address is the wrong data for the field on spec grounds before you
even reach privacy. GDPR Art. 25(2) requires that *by default* personal data is not made accessible to
an indefinite number of people without the individual's intervention, which is exactly what defaulting
a sole trader's home address into outbound invites would do. Recommendation: a new tenant-level
`venueAddress` (explicit, editable, opt-in, empty by default), and `LOCATION` resolved per-service:
Meet/Teams URL for online, the **customer's** address for `customerAddressRequired` jobs, the venue
address for at-premises jobs, and **omitted** otherwise. Stop emitting the literal string `"In person"`
as a `LOCATION` — it is not a venue and the spec's value is a venue.

**2. Owner/customer email split — the current arrangement is spec-legal but is justified by an
undocumented claim, and it should change in two specific ways.** RFC 5545 does not require `ORGANIZER`
to equal the message sender, and RFC 6047 §2.3 says outright that the organizer "cannot be reliably
inferred by the RFC5322 Sender or Reply-To" — so a platform `ORGANIZER` breaks no rule. `SENT-BY` is
the spec-sanctioned "acting on behalf of" mechanism, **but Microsoft documents that Outlook ignores
every instance of `SENT-BY` on import**, and Google documents nothing about it — so adopting `SENT-BY`
would buy approximately nothing today. Two changes are worth making: (a) Google's own Calendar API
guidance explicitly says *don't* use one generic sending address and recommends "a unique and static
email address for each organizer" — the current single `EMAIL_FROM_ADDRESS` is the anti-pattern Google
names; (b) split the owner notification from the customer invite, because today both are one message
with two recipients and the owner is neither `ORGANIZER` nor `ATTENDEE` in the ICS they receive.
Also note: **nothing in this codebase consumes an RSVP reply**, so the RSVP controls the current design
is optimised for are cosmetic.

**3. Git history purge — do the rewrite, but for hygiene, not for security, and only because it is
unusually cheap here.** I verified the blobs: no secret values, only env-var *names* and blank
`_______` placeholders (the untrack commit message's claim of "reviewer test credentials" is wrong —
the document *instructs* the reader to create tester credentials, it does not contain any). GitHub's
own guidance says that when the exposure is a credential, rotation may make a rewrite unwarranted; here
there is not even a credential. So the security case is nil. What tips it is that every cost GitHub
lists is near-zero for this repo: **0 forks, 1 collaborator (the owner), 0 open PRs, 0 PR refs in the
affected range, `main` is the only branch on the remote, 0 tags, and only `main` locally contains the
commit.** If it is ever going to be cheap, it is now. If you would rather not touch history at all,
untrack+gitignore is a defensible answer — but then do it knowingly, not on the belief that the files
are gone.

---

## Question 1 — the business venue address on the calendar invite

### 1.1 What the code does today

**[REPO]** The ICS builder supports `LOCATION` but almost nothing populates it:

- `api/src/booking/booking-providers/ics.ts:19` declares `location?: string`; `ics.ts:113` emits
  `LOCATION:` only when it is present.
- All three call sites — create, reschedule, cancel — compute it identically:
  `api/src/booking/booking-providers/internal.provider.ts:1007`, `:1694`, `:1919`:
  `location: meetUrl ?? (service.locationType === 'in_person' ? 'In person' : undefined)`.
- So the only two values a customer can ever receive are a Google Meet URL or the literal string
  `"In person"`. `docs/booking-epic-gap-analysis.md:254-255` already recorded this: *"For `in_person`
  it sends the literal string `"In person"` — there is no business-address field anywhere — so the
  customer never receives an actual address."*

**[REPO]** `locationType` is `'google_meet' | 'phone' | 'in_person' | 'custom'`
(`api/src/database/entities/ServiceType.ts:24`), stored at `ServiceType.ts:147-148` with default
`'custom'`, and validated by `api/src/schemas/scheduler.schema.ts:58` and `:136`. Only `in_person` and
(implicitly) `google_meet` are read anywhere. `'phone'` and `'custom'` produce **no** `LOCATION` at all
— and `'custom'`, which is the schema default, has no accompanying free-text field anywhere in the
entity, so it is a value that cannot mean anything today. **[JUDGEMENT]** That is a latent bug in its
own right: the default value of the field is the one value the system cannot act on.

**[REPO]** The two "who travels" flags are separate and one is misnamed:
`ServiceType.ts:128` `customerLocationRequired` and `ServiceType.ts:131` `customerAddressRequired`.
`internal.provider.ts:155-157` documents the wart explicitly — *"customerLocationRequired maps to PHONE
(a callback number), not address"*. The address gate is enforced at `internal.provider.ts:234` and
surfaced to the prompt at `api/src/modules/booking.module.ts:217-220`. Presets that set it are the
cleaning ones (`api/src/scheduler/presets.ts:122-124`) — i.e. exactly the "owner travels to the
customer" case.

**[REPO]** The customer's address is already captured (`api/src/database/entities/Booking.ts:122-123`,
`varchar(512)`, free text) and already leaves the platform: it is rendered into the **owner's**
calendar-event description as an `Address:` line at
`api/src/booking/booking-providers/booking-content.ts:195`. It is not put in `LOCATION`.

**[REPO]** Neither mirrored calendar event carries a location at all. The shared input type
`CalendarEventInput` (`api/src/integrations/google/google-calendar.service.ts:421-427`) has only
`startISO/endISO/timezone/summary/description` — no location field. The Google create payload
(`google-calendar.service.ts:468-480`) sends `summary`, `description`, `start`, `end`, `conferenceData`
and nothing else; the Outlook create payload (`api/src/integrations/microsoft/outlook-events.service.ts:137-142`)
sends `subject`, `body`, `start`, `end`, `transactionId`. Outlook imports the same type
(`outlook-events.service.ts:21-26`). So the "no business address anywhere" statement holds for all three
surfaces: ICS, Google, Outlook.

**[REPO]** The only address the platform stores about the business is the VAT/legal one, and the
gap analysis is right about its provenance and its uselessness
(`docs/booking-epic-gap-analysis.md:53-54`): *"a business address captured **once** by the onboarding
wizard into `tenant.settings.onboarding.company.{street,postalCode,city}` — and read by nothing
afterwards."* Concretely:

- Shape: `api/src/onboarding/onboarding-state.ts:69-82` — `OnboardingCompany { vatNumber, name,
  legalForm, street, postalCode, city, verified }`.
- Storage: inside the `settings` jsonb on the tenant, `api/src/database/entities/Tenant.ts:180`.
- Written once, at `api/src/routes/onboarding.routes.ts:244-253`, from a VIES lookup
  (`api/src/integrations/company-lookup/company-lookup.service.ts:74`, `:139`) whose free-text address
  is best-effort parsed and left partially empty rather than force-fitted
  (`company-lookup.service.ts:71-79`).
- The only UI is the first-run wizard step `portal/src/pages/setup/steps/CompanyStep.tsx:97`. There is
  no settings screen that edits it afterwards. **[REPO]** confirmed by absence — no other portal
  surface reads or writes `onboarding.company`.

**[JUDGEMENT]** So the stated reason for leaving `LOCATION` empty is sound on the facts: the field is
tenant-wide, write-once, unvalidated, has no edit screen, is NULL for every grandfathered tenant, and
for a Belgian sole trader is frequently a home or accountant's address.

### 1.2 What RFC 5545 actually says `LOCATION` is

**[SPEC]** RFC 5545 §3.8.1.7 (https://www.rfc-editor.org/rfc/rfc5545.txt):

> **Purpose:** This property defines the intended venue for the activity defined by a calendar
> component.
>
> **Value Type:** TEXT
>
> **Description:** Specific venues such as conference or meeting rooms may be explicitly specified
> using this property. An alternate representation may be specified that is a URI that points to
> directory information with more structured specification of the location. For example, the alternate
> representation may specify either an LDAP URL [RFC4516] pointing to an LDAP server entry or a CID URL
> [RFC2392] pointing to a MIME body part containing a Virtual-Information Card (vCard) [RFC2426] for
> the location.

Its example is `LOCATION:Conference Room - F123\, Bldg. 002`.

Three things follow directly:

1. **[SPEC]** The data model is a single unstructured `TEXT` value. There is no street/postcode/city
   decomposition in `LOCATION` itself. The only structure the base spec offers is the `ALTREP`
   parameter, which is a *URI pointing elsewhere*, not structured data inline.
2. **[SPEC]** The semantics are "venue", not "the organisation's registered address". A legal/VAT
   address is a different concept that happens to be an address.
3. **[SPEC]** `LOCATION` is optional in an iTIP `REQUEST`: RFC 5546's constraint table for
   `METHOD:REQUEST` of a `VEVENT` lists `LOCATION | 0 or 1`
   (https://www.rfc-editor.org/rfc/rfc5546.txt). Omitting it is fully conformant.

**[JUDGEMENT]** Emitting `"In person"` as a `LOCATION` is spec-legal (it is `TEXT`) but is a misuse of
the property's stated purpose: "In person" is a modality, not a venue. It also actively costs
something — because the email body derives its `Location:` line from the same value
(`api/src/booking/booking-providers/booking-email.ts:163`), the customer is shown a "Location" that
tells them nothing.

### 1.3 Structured location alternatives

**[SPEC]** RFC 9073, *Event Publishing Extensions to iCalendar*
(https://www.rfc-editor.org/rfc/rfc9073.txt), states the problem exactly:

> The "LOCATION" property [RFC5545] provides only an unstructured single text value for specifying the
> location where an event (or task) will occur. This is inadequate for use cases where structured
> location information (e.g., address, region, country, or postal code) is required or preferred and
> limits widespread adoption of iCalendar in those settings.
>
> Using the "VLOCATION" component, rich information about multiple locations can be communicated in a
> "STRUCTURED-DATA" property; examples include address, region, country, postal code, parking
> availability, nearby restaurants, and the venue, among others.

It also defines a `LOCATION-TYPE` property for `VLOCATION` components whose values come from RFC 4589
(RFC 9073 §6.1).

**[SILENT]** Neither Google's Calendar API reference nor Microsoft Graph's event/location reference
mentions `VLOCATION`, `STRUCTURED-DATA` or RFC 9073. I found no first-party statement from either
vendor that they consume or emit it. **[JUDGEMENT]** Treat RFC 9073 as not usable for this product's
purpose today.

**[SILENT]** On `X-APPLE-STRUCTURED-LOCATION`: I could not find any Apple primary source — developer
documentation, support documentation, or open-source release — that documents this property, its
grammar, or its semantics. It is an `X-` vendor extension, which RFC 5545 permits without registration,
but Apple has not published its definition. The closest first-party statement is about the *user-facing
effect* of setting a location in Apple Calendar, quoted below. **Do not implement against
`X-APPLE-STRUCTURED-LOCATION` on the basis of reverse-engineered examples** — there is no contract to
rely on.

### 1.4 What the vendors document about the location field

**[VENDOR] Google Calendar API** — the `Events` resource reference
(https://developers.google.com/workspace/calendar/api/v3/reference/events) defines `location` as:

> Geographic location of the event as free-form text. Optional.

and it is writable. **[SILENT]** The reference says nothing about geocoding, map lookup, or coordinate
resolution of the string, and nothing about the behaviour of an absent or empty `location`. I checked
specifically for this and Google does not document it. **[JUDGEMENT]** Treat Google `location` as
opaque free text that is displayed; do not assume it is resolved to a place.

**[VENDOR] Microsoft Graph** — the `event` resource
(https://learn.microsoft.com/en-us/graph/api/resources/event) has both:

> `location` | Location | The location of the event.
>
> `locations` | Location collection | The locations where the event is held or attended from. The
> **location** and **locations** properties always correspond with each other. If you update the
> **location** property, any prior locations in the **locations** collection are removed and replaced
> by the new **location** value.

and the `location` resource (https://learn.microsoft.com/en-us/graph/api/resources/location) *is*
structured — `displayName` ("The name associated with the location"), `address` (a `physicalAddress`,
"The street address of the location"), `coordinates`, plus a read-only `locationType`. Microsoft
documents that the type you get depends on how the event was created:

> | create event REST API | **locationType** | `default` |
> | User interface in Outlook | **locationType** | One of the following: `default` for a location
> entered as plain text, `conferenceRoom` for a room provided by the Outlook rooms list. Or, any of this
> list - `homeAddress`, `businessAddress`, `geoCoordinates`, `streetAddress`, `hotel`, `restaurant`,
> `localBusiness`, `postalAddress` - for a location from Bing Autosuggest or Bing local search.

**[JUDGEMENT]** Two implications. First, Graph is the one surface where a *structured* venue could be
sent (`location.displayName` + `location.address`), so a venue-address field should be modelled with
street/postcode/city components even if ICS and Google only ever receive a flattened one-liner — it
costs nothing now and avoids a re-parse later. Second, Microsoft's own vocabulary distinguishes
`homeAddress` from `businessAddress`, which is a useful reminder that "the address on file" and "the
place the customer should go" are different concepts even to a calendar vendor.

**[VENDOR] Apple** — the only first-party statement I found on what a client *does* with a location is
Apple's Calendar user guide
(https://support.apple.com/guide/calendar/add-location-and-travel-time-to-events-icl43600/mac):

> a map and weather information are also added, and an alert is set so you're notified when it's time
> to leave

and the field accepts "an address, a business name, or a type of business (such as 'coffee shop' or
'museum')".

**[SILENT] How clients treat an address vs a URL vs empty.** This is the part where I have to be
blunt: there is no first-party documentation from Google or Microsoft describing how their clients
*render* a `LOCATION` that is a URL rather than an address, or what they show when it is absent. Google
Calendar Help and Gmail Help have community threads on it; those are not primary sources and are
excluded. What I can say from primary sources is: Google treats it as free-form text; Microsoft models
it as a structured object whose `displayName` is "the name associated with the location"; Apple states
it will attempt a map/travel-time treatment. Everything beyond that would be invention.

**[JUDGEMENT]** For the current code, the practical consequence is that stuffing a Meet URL into
`LOCATION` (`internal.provider.ts:1007`) is a convention rather than a documented contract. It is
harmless and widely done, but if online-meeting handling is ever revisited, the *documented* mechanisms
are Google's `conferenceData` (already used at `google-calendar.service.ts:472`) and Graph's
`isOnlineMeeting`/`onlineMeetingProvider` (already used at `outlook-events.service.ts:154`) — not
`LOCATION`.

### 1.5 The GDPR angle

The relevant primary text is Regulation (EU) 2016/679 itself
(https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679).

**[SPEC] It is personal data.** Art. 4(1): *"'personal data' means any information relating to an
identified or identifiable natural person ('data subject')"*. Recital 14 draws the line that matters
for this product: *"This Regulation does not cover the processing of personal data which concerns legal
persons and in particular undertakings established as legal persons, including the name and the form of
the legal person and the contact details of the legal person."* **[JUDGEMENT]** So a BV/SRL's
registered office is not personal data, but a Belgian sole trader's registered address — which is
frequently their home — relates to a natural person and is. The platform cannot tell these apart from
the VAT record alone, which means the *safe* default has to be the one that assumes personal data.

**[SPEC] Disclosure is processing.** Art. 4(2) includes *"disclosure by transmission, dissemination or
otherwise making available"*. Emailing an invite to a stranger is squarely within it.

**[SPEC] Minimisation.** Art. 5(1)(c): personal data shall be *"adequate, relevant and limited to what
is necessary in relation to the purposes for which they are processed ('data minimisation')"*.

**[SPEC] Accuracy.** Art. 5(1)(d): *"accurate and, where necessary, kept up to date; every reasonable
step must be taken to ensure that personal data that are inaccurate ... are erased or rectified without
delay"*. **[JUDGEMENT]** A write-once field with no edit screen (`CompanyStep.tsx:97` is the only
writer) cannot satisfy this once it becomes customer-facing. Today it is inert, so accuracy is moot;
the moment it is printed on outbound invites it stops being moot.

**[SPEC] And the one that decides this question — Art. 25(2), data protection by default:**

> The controller shall implement appropriate technical and organisational measures for ensuring that,
> by default, only personal data which are necessary for each specific purpose of the processing are
> processed. That obligation applies to the amount of personal data collected, the extent of their
> processing, the period of their storage and their accessibility. **In particular, such measures shall
> ensure that by default personal data are not made accessible without the individual's intervention to
> an indefinite number of natural persons.**

**[JUDGEMENT]** That last sentence describes the proposed change almost literally. "Silently start
printing the address we already hold on every outbound invite" = personal data made accessible to an
indefinite number of natural persons (every future customer) without the individual's intervention.
"A separate field the owner fills in on purpose, empty by default" = the individual's intervention.
The regulation does not forbid putting a venue on an invite; it forbids getting there without the
person acting. This is the strongest argument in the whole question and it points one way.

**[JUDGEMENT] On the controller/processor split:** for the tenant's *customers'* data (the customer
address at `Booking.ts:122`), the tenant is controller and Axentrio processor. But for the *owner's own*
home address, the owner is the data subject and Axentrio is the controller of its own customer
relationship. That is Axentrio's own Art. 25 exposure, not something a DPA passes downstream. I have
not found EDPB guidance addressing this exact pattern and am not going to cite guidance I have not
read — Art. 25(2) is sufficient and it is the regulation text.

### 1.6 Recommendation for Q1

**Introduce a separate venue address. Do not reuse the VAT/legal address for this, ever, not even as a
prefill default.** [JUDGEMENT, grounded in Art. 25(2) and RFC 5545 §3.8.1.7 above]

Design:

1. **New field, tenant-level, opt-in, empty by default.** `venueAddress` with components
   (street / postcode / city / country) plus a derived one-line form. Components because Graph can take
   structure (`location.address`) and ICS/Google cannot — flattening later is free, parsing later is
   not. Empty by default is the Art. 25(2) requirement, not a preference.
2. **Give it an edit screen.** Non-negotiable if it is going on customer-facing invites (Art. 5(1)(d)).
   This is also what makes the field *the owner's decision* rather than a silent re-purposing.
3. **Do not prefill it from `onboarding.company`.** [JUDGEMENT] A prefilled field that the owner
   clicks past is not "the individual's intervention"; it is the default they didn't notice. If a
   prefill is wanted for convenience, it must be an explicit "use my registered address" button that
   the owner presses.
4. **Resolve `LOCATION` per service:**

   | Case | `LOCATION` carries |
   |---|---|
   | `locationType = google_meet` (or Teams) | the meeting URL, as today |
   | `in_person` **and** `customerAddressRequired` (owner travels) | the **customer's** address (`Booking.customerAddress`) |
   | `in_person` **and not** `customerAddressRequired` (at premises) | the venue address, if set |
   | venue address not set, `phone`, or `custom` | **omit `LOCATION` entirely** |

   The customer's own address in the customer's own invite discloses nothing new to them, and it is the
   genuinely useful value for the owner's copy — which today only gets it as a description line
   (`booking-content.ts:195`). RFC 5546 permits omission (`LOCATION | 0 or 1`), so the empty case is
   conformant rather than degraded.

5. **Stop sending `"In person"` as a `LOCATION`.** If the modality is worth telling the customer, put
   it in the email body as its own line, not in a field the spec defines as a venue. [JUDGEMENT]
6. **Backfill: none.** Grandfathered tenants have no venue address and should keep sending invites
   without a `LOCATION` until they enter one.

**What this does not need:** RFC 9073 `VLOCATION`, `X-APPLE-STRUCTURED-LOCATION`, geocoding, or a
service-area radius. The gap analysis already carves service area out as deliberate
(`docs/booking-epic-gap-analysis.md:40-41`); nothing here reopens it.

---

## Question 2 — the owner/customer email and `ORGANIZER` split

### 2.1 What the code does today

**[REPO]**

- `api/src/booking/booking-providers/internal.provider.ts:414`:
  `const FROZEN_ORGANIZER = config.email.fromAddress;` — stamped on every new booking at `:930`,
  `:1013` and `:1098`.
- The reasoning is in the comment at `internal.provider.ts:406-413`:
  > The platform address, not the tenant's — deliberately. Resend only sends from verified domains, so
  > the envelope sender is always this address; an ORGANIZER that disagreed with it made Gmail and
  > Outlook refuse to render RSVP controls. The business's identity rides along as the organizer's
  > display name, and its real address as the reply-to.
- `config.email.fromAddress` is `EMAIL_FROM_ADDRESS`
  (`api/src/config/environment.ts:483`, schema at `:151`) — **one address for the entire platform**.
- The ICS carries the business only as a display name:
  `ics.ts:92-94` emits `ORGANIZER;CN="<business>":mailto:<platform address>`;
  `internal.provider.ts:1014` supplies `organizerName` from the brand-voice business name or tenant name.
- The tenant's real address is `Reply-To` only: `booking-email.ts:181`, with the rationale at `:177-180`.
- Frozen per booking on `Booking.organizer_email` (`api/src/database/entities/Booking.ts:164`, migration
  `api/src/database/migrations/1788700000000-AddBookingOrganizerEmail.ts:16`), resolved at
  `booking-email.ts:130` as `organizerEmail || ownerEmail || platform`.
- **[REPO] A wrinkle worth naming:** the backfill migration
  `api/src/database/migrations/1788900000000-BackfillBookingOrganizer.ts:24-27` set pre-column rows to
  the **bot's `ai.supportEmail`** — the tenant's own address — while every new row gets the platform
  address. So production contains two populations with structurally different `ORGANIZER` values. That
  was the right call for those rows (it froze what had already been sent), but it means "our
  `ORGANIZER` is always the platform" is not true of the whole table.

**[REPO] One message, two audiences.** `booking-email.ts:146` builds
`to = [attendeeEmail, ...(ownerEmail ? [ownerEmail] : [])]` and sends a **single** message at `:173-192`
with one body, one subject (`"Confirmed: <service>"`), one ICS attachment, and copy addressed to the
customer (`"Your appointment is confirmed."`, `:150-151`). The owner therefore receives a
customer-worded email, and the two recipients see each other's addresses in the `To` header. The only
place the owner gets their own message is the no-customer-email path,
`notifyOwnerWithoutInvite` (`booking-email.ts:93-114`), which correctly sends a plain email with no ICS
and explains why (`:88-92`).

**[REPO] The owner has no role in the ICS they receive.** `ics.ts:95-97` emits exactly one `ATTENDEE`,
the customer. The owner is neither `ORGANIZER` (that is the platform) nor `ATTENDEE`.

**[REPO] Nothing consumes an RSVP.** `IcsMethod` is `'REQUEST' | 'CANCEL'` only (`ics.ts:9`). There is
no `METHOD:REPLY` handling, no `PARTSTAT` parsing anywhere outside the outbound builder
(`ics.ts:97` is the only hit), and no inbound-email route or Resend inbound webhook in `api/src/routes/`.
Customer self-service reschedule/cancel goes through the manage URL (`booking-email.ts:168-170`),
not through RSVP. **[JUDGEMENT]** So an RSVP a customer clicks today is fired at
`EMAIL_FROM_ADDRESS` and lands nowhere. The RSVP controls the frozen-`ORGANIZER` design exists to
preserve are decorative.

### 2.2 What the specs require

**[SPEC] `ORGANIZER` — RFC 5545 §3.8.4.3** (https://www.rfc-editor.org/rfc/rfc5545.txt):

> **Purpose:** This property defines the organizer for a calendar component.
> **Value Type:** CAL-ADDRESS
> **Conformance:** This property MUST be specified in an iCalendar object that specifies a
> group-scheduled calendar entity.
> ... The property has the property parameters "CN", for specifying the common or display name
> associated with the "Organizer", "DIR" ... , "SENT-BY", for specifying another calendar user that is
> acting on behalf of the "Organizer".

Its own example of the delegated form:

> The following is an example of this property used by another calendar user who is acting on behalf of
> the organizer, with responses intended to be sent back to the organizer, not the other calendar user:
>
> `ORGANIZER;SENT-BY="mailto:jane_doe@example.com":mailto:jsmith@example.com`

**[SPEC] `SENT-BY` — RFC 5545 §3.2.18:**

> **Purpose:** To specify the calendar user that is acting on behalf of the calendar user specified by
> the property. ... The parameter value MUST be a mailto URI as defined in [RFC2368].

**[SPEC] `ATTENDEE` — RFC 5545 §3.8.4.1:** MUST be specified in a group-scheduled object; carries
`ROLE`, `PARTSTAT`, `RSVP`, and its own `SENT-BY` "to indicate whom is acting on behalf of the ATTENDEE".

**[SPEC] iTIP — RFC 5546** (https://www.rfc-editor.org/rfc/rfc5546.txt). §2.1.3:

> First, the "Organizer" is treated as a special entity, separate from "Attendees". All responses from
> "Attendees" flow to the "Organizer" ...
>
> Second, a "SENT-BY" parameter may be specified in either the "Organizer" or "Attendee" properties.
> When specified, the "SENT-BY" parameter indicates that the responding CU acted on behalf of the
> specified "Attendee" or "Organizer".

§3.2.2.5, *Sending on Behalf of the Organizer*:

> There are a number of scenarios that support the need for a "Calendar User" to act on behalf of the
> "Organizer" without explicit role changing. ... Using the "SENT-BY" parameter, a "Calendar User"
> could send an updated "VEVENT" "REQUEST". In the case where one CU sends on behalf of another CU, the
> "Attendee" responses are still directed back towards the CU designated as "Organizer".

And the `METHOD:REQUEST` constraint table requires `ORGANIZER | 1` and `ATTENDEE | 1+`.

**[SPEC] iMIP — RFC 6047 §2.3** (https://www.rfc-editor.org/rfc/rfc6047.txt) — this is the passage that
settles whether the current design is legal:

> The calendar address specified within the "ORGANIZER" and "ATTENDEE" properties in an iCalendar object
> sent using iMIP MUST be a proper "mailto:" [MAILTO] URI specification for the corresponding
> "Organizer" or "Attendee" of the "VEVENT" or "VTODO".
>
> Because [iTIP] does not preclude "Attendees" from forwarding "VEVENT"s or "VTODO"s to others, the
> [RFC5322] "Sender" value may not equal that of the "Organizer". Additionally, the "Organizer" or
> "Attendee" cannot be reliably inferred by the [RFC5322] "Sender" or "Reply-To" header field values of
> an iMIP message. The relevant address MUST be ascertained by opening the "text/calendar" MIME body
> part and examining the "ATTENDEE" and "ORGANIZER" properties.

**[SPEC]** RFC 6047 §2.4 requires the `method` MIME parameter to match the `METHOD` property — which
the code does correctly at `booking-email.ts:189`.

**[SPEC]** RFC 6047 §2.2.1 also notes the limit of `SENT-BY` as an assurance:

> [RFC1847] message flow in iTIP supports someone working on behalf of a "Calendar User" through use of
> the "sent-by" parameter ... However, there is no mechanism to verify whether or not a "Calendar User"
> has authorized someone to work on their behalf.

**Reading of the specs, direct answers to the questions asked:**

- **Does RFC 5545 permit an `ORGANIZER` that differs from the actual sender?** Yes, unambiguously. RFC
  6047 §2.3 states as a matter of fact that the Sender may differ from the Organizer and that the
  Organizer cannot be inferred from Sender or Reply-To. [SPEC]
- **Is `SENT-BY` the sanctioned mechanism for "we send on behalf of the business"?** Yes — RFC 5545
  §3.2.18 and RFC 5546 §3.2.2.5 define exactly this. [SPEC]
- **What does the spec require for a valid RSVP round-trip?** That responses flow to the `ORGANIZER`
  (RFC 5546 §2.1.3), and that the `REQUEST` carry `ORGANIZER | 1` and `ATTENDEE | 1+`. [SPEC]
- **[JUDGEMENT]** Therefore, the current design is *spec-conformant for the customer* — the customer is
  the sole `ATTENDEE` and the `ORGANIZER` is a real, deliverable mailbox. It is *not* conformant in
  spirit for the owner, who receives a `METHOD:REQUEST` in which they hold no role at all; RFC 5546
  frames a `REQUEST` as something sent to `Attendees`.
- **[JUDGEMENT]** And the frozen platform `ORGANIZER` has a real consequence the code comment does not
  mention: per RFC 5546 §2.1.3 responses flow to the `ORGANIZER`, so the platform address is where every
  RSVP goes — and §2.1 above establishes nothing reads it.

### 2.3 What the vendors document

**[VENDOR] Google — and this is the most directly useful source in this section.** The Calendar API
concept page *Invite users to an event*
(https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events) covers this
exact product shape, including an appointment-booking worked example:

> **Invite user from an email address**
>
> If you don't have write access to the organizer's Google Calendar, or if you don't want to expose the
> organizer's email address, use the iCalendar protocol (RFC-5545) to invite users with email using an
> .ICS file.
>
> If the attendee is a Google Calendar user with the setting `Only if the sender is known` and they
> haven't previously interacted with or recorded the address as known to them, the invitation isn't
> added to their calendar until they click **Add to calendar** or they RSVP to the event.
>
> **Tip:** Don't use a generic email address (for example: invitation@example.com) for sending
> invitations because any abuse might impact all users that send invitations from this address. If you
> can't use the organizer's email address, we recommend using a unique and static email address for each
> organizer.

and, in the booking example:

> If the business doesn't want to expose their email address, use a user-specific email address to send
> the event to the booker by using email (Invite user from an email address).

**[JUDGEMENT]** Three things fall out. (a) Google explicitly blesses the emailed-ICS approach for this
scenario — the architecture is right. (b) Google explicitly warns against *one generic sending address*
and recommends "a unique and static email address for each organizer" — which is precisely what
`EMAIL_FROM_ADDRESS` is not (`environment.ts:483`). (c) Google documents that whether the event lands on
the customer's calendar at all depends on the customer's own "Only if the sender is known" setting and
on prior interaction with the sending address — which is a *deliverability-of-meaning* argument for
per-tenant addresses that build their own reputation, and against one shared address whose reputation is
shared platform-wide.

**[SILENT] Google does not document the conditions under which Gmail renders RSVP buttons for an
emailed `.ics`.** I looked in the Calendar API docs, Gmail developer docs, and Google's Calendar/Gmail
help. There is no first-party statement that the `ORGANIZER` must match the `From` header for RSVP
controls to appear. The community threads that assert it are not primary sources and are excluded here.
**This matters, because that unverified claim is the entire justification recorded at
`internal.provider.ts:410-411`.**

**[VENDOR] Google — sender authentication**, *Email sender guidelines*
(https://support.google.com/mail/answer/81126): all senders must "Set up SPF or DKIM email
authentication for your sending domains" and "Don't impersonate Gmail From: headers"; bulk senders must
set up SPF **and** DKIM **and** DMARC, and:

> For direct email, the domain in the sender's From: header must be aligned with either the SPF domain
> or the DKIM domain. This is required to pass DMARC alignment.

**[VENDOR] Microsoft — and this is the finding that kills the `SENT-BY` option.**
`[MS-STANOICAL]`, Microsoft's published deviations from the iCalendar standards, entry V0258 for
RFC 5546 §3.2.2.5
(https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/374c8a03-e309-494e-be48-1d6191a5889f):

> Outlook indicates that a user is sending a REQUEST-type iCalendar object on behalf of the **ORGANIZER**
> using the **X-MS-OLK-SENDER** property ([MS-OXCICAL] section 2.1.3.1.1.20.61). Outlook sends responses
> to the **ORGANIZER**.
>
> **On import, Outlook ignores all instances of the *SENT-BY* parameter.**

listed against Outlook 2007 through "Microsoft Outlook for Windows (new)".

**[VENDOR] Microsoft — how an emailed ICS becomes a meeting request.** `[MS-OXCICAL]` "Property: METHOD"
(https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/7befe35d-0652-447f-a780-d5fd5b879d38)
documents the mapping — `METHOD:REQUEST` → `IPM.Schedule.Meeting.Request`, `REPLY`+`PARTSTAT` →
`IPM.Schedule.Meeting.Resp.*`, `CANCEL` → `IPM.Schedule.Meeting.Canceled`, default/`PUBLISH` →
`IPM.Appointment`. So the thing that makes Outlook treat the attachment as an actionable meeting request
is documented to be the **`METHOD` property**, not the `From` header. The code sets it correctly
(`ics.ts:104`, MIME parameter at `booking-email.ts:189`).

**[VENDOR] Microsoft — `ORGANIZER` import.** `[MS-OXCICAL]` "Property: ORGANIZER"
(https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/088b8ca4-199c-4a93-bd5f-590dc9126319):

> This property SHOULD be parsed as a valid mailto URI as specified in [RFC2368]. The resulting SMTP
> address SHOULD be resolved against the address book ... If no match was found, a one-off EntryID MUST
> be created using the SMTP address and the CN parameter.

**[JUDGEMENT]** Note what that means for the `CN` trick the code uses (`ics.ts:92-94`): when the
organizer address is unknown to the recipient's address book — which for a platform address it always
will be — Outlook is documented to build the entry from *the SMTP address and the CN parameter*. So the
business name in `CN` genuinely is the thing Outlook shows. That part of the current design is
well-founded and is confirmed by Microsoft's own spec.

**[SILENT] Microsoft does not document a `From`-vs-`ORGANIZER` requirement for rendering RSVP controls
either.** I looked through `[MS-OXCICAL]` and `[MS-STANOICAL]`. The documented determinant is `METHOD`.
No Microsoft source states that a mismatched sender suppresses the accept/decline controls.

**[VENDOR] Resend — verified domains.** *Domains* (https://resend.com/docs/dashboard/domains/introduction):

> You must add and verify at least one domain to send and receive emails with Resend.

and subdomains are recommended to isolate sending reputation, each verified independently. The send
endpoint (https://resend.com/docs/api-reference/emails/send-email) documents `from` as "Sender email
address. To include a friendly name, pass the sender as `Name <email@example.com>`", `reply_to` as
"Reply-to email address. For multiple addresses, send as an array of strings.", plus `attachments`,
`headers` ("Custom headers to add to the email") and an `Idempotency-Key`.

**[VENDOR] Resend — per-tenant sending is possible.** The Domains API
(https://resend.com/docs/api-reference/domains/create-domain) creates domains programmatically, with a
`custom_return_path` used for "SPF authentication, DMARC alignment, and handling bounced emails". So a
per-tenant *domain* is supported by the vendor — **[JUDGEMENT]** but it requires each tenant to own a
domain and publish DNS records, which for a solo Belgian plumber on a Gmail address is not a realistic
onboarding step. A per-tenant *address on the platform's own verified domain* needs no vendor feature at
all and no DNS from the tenant.

**[SPEC] Why the `From` must stay on the platform domain.** DMARC (RFC 7489
https://www.rfc-editor.org/rfc/rfc7489.txt) §3.1:

> DMARC authenticates use of the RFC5322.From domain by requiring that it match (be aligned with) an
> Authenticated Identifier. The RFC5322.From domain was selected as the central identity of the DMARC
> mechanism because it is a required message header field ... most Mail User Agents (MUAs) represent the
> RFC5322.From field as the originator of the message and render some or all of this header field's
> content to end users.

Combined with Google's alignment requirement above and Resend's verified-domain requirement:
**[JUDGEMENT]** setting `From:` to a tenant's own `@gmail.com`/`@telenet.be` address would be
unauthenticated spoofing that fails DMARC alignment and would be rejected or junked. This constraint in
the code comment is correct and is the one part of the rationale that primary sources fully support.

**[SPEC] The header for "we transmitted this on someone's behalf" is `Sender:`, not a mangled `From:`.**
RFC 5322 §3.6.2 (https://www.rfc-editor.org/rfc/rfc5322.txt):

> The "From:" field specifies the author(s) of the message ... The "Sender:" field specifies the mailbox
> of the agent responsible for the actual transmission of the message. For example, if a secretary were
> to send a message for another person, the mailbox of the secretary would appear in the "Sender:" field
> and the mailbox of the actual author would appear in the "From:" field.

**[JUDGEMENT]** This is the email-layer analogue of `SENT-BY`, and it has the same problem: it puts the
tenant's unauthenticated domain in `From:`, so DMARC alignment fails. Not usable. Noted only so that the
option is closed explicitly rather than left hanging.

### 2.4 Recommendation for Q2

**On `ORGANIZER` vs `SENT-BY`:**

**Do not adopt `SENT-BY`.** [JUDGEMENT] The spec-purist answer would be
`ORGANIZER;SENT-BY="mailto:<platform>";CN="<business>":mailto:<tenant>` — that is literally RFC 5545
§3.8.4.3's own example. But Microsoft documents that **Outlook ignores every `SENT-BY` on import**
([MS-STANOICAL] V0258), Google documents nothing about it, and RFC 6047 §2.2.1 says there is no way to
verify the delegation anyway. What it *would* do is move `ORGANIZER` to the tenant's real address —
which is where responses go (RFC 5546 §2.1.3) — and the platform cannot process responses either way,
so the round trip does not improve. It would also start printing the owner's personal address into every
customer's calendar entry, which is the Q1 problem in a different field.

**Keep the platform-domain `ORGANIZER`, but stop using one address for all tenants.**
[JUDGEMENT, following Google's documented recommendation] Move from a single `EMAIL_FROM_ADDRESS` to a
per-tenant, stable, platform-domain address — `<tenant-slug>@bookings.axentrio.com` or equivalent — and
use that same address as **both** the `From:` and the ICS `ORGANIZER`. This:

- follows Google's explicit guidance ("we recommend using a unique and static email address for each
  organizer"; "Don't use a generic email address ... because any abuse might impact all users that send
  invitations from this address");
- keeps `From:` on a Resend-verified, DMARC-aligned domain (RFC 7489 §3.1, Google sender guidelines);
- keeps `From:` and `ORGANIZER` identical, so the undocumented Gmail/Outlook claim at
  `internal.provider.ts:410-411` stays satisfied *whether or not it is true* — the change costs nothing
  if the claim is real and gains reputation isolation if it isn't;
- lets a customer's "sender is known" state accrue per business rather than platform-wide, which is the
  behaviour Google documents;
- needs no vendor feature and no DNS from the tenant — `EmailService.send` already accepts a `from`
  override (`api/src/automations/email.service.ts:47`, `:54`, `:64`), so the plumbing exists.

Keep `Reply-To` = the tenant's real address (`booking-email.ts:181`) and `CN` = the business name
(`ics.ts:92-94`) — both are correct today and Microsoft's `ORGANIZER` import spec confirms `CN` is what
Outlook will display for an unknown address.

**Re-test the load-bearing claim before building on it.** [JUDGEMENT] The comment at
`internal.provider.ts:410-411` is the reason this design exists and **no primary source from Google or
Microsoft supports it**. It may well be a true observation; it is not a documented contract. Whoever
touches this next should re-verify it empirically rather than inherit it, and record what they saw.

**On owner-facing vs customer-facing mail: yes, split them.** [JUDGEMENT]

1. The customer gets the invite: customer-worded body, the ICS with `METHOD:REQUEST`, exactly one
   `ATTENDEE` (them), the manage link. Essentially today's message minus the owner.
2. The owner gets their own message: owner-worded ("New booking: …"), with the operational content —
   customer name, phone, address, intake answers, booking reference — that already exists in
   `buildBookingEventContent` (`booking-content.ts:184-227`) but which the owner only sees today if
   their calendar is connected. `notifyOwnerWithoutInvite` (`booking-email.ts:93-114`) is already the
   right shape for this; it is currently reachable only when the customer has no email.
3. This also fixes three things at once: the owner stops receiving a `METHOD:REQUEST` in which they hold
   no role (RFC 5546 frames `REQUEST` as addressed to `Attendees`); the customer stops seeing the
   owner's address in the `To` header; and each audience gets copy written for it.
4. Keep the per-audience idempotency keys — `inviteIdempotencyKey` already takes an `audience`
   argument (`booking-email.ts:85-86`) and already distinguishes `'invite'` from `'owner-only'`, so the
   split needs no new dedupe design.

**Two things to note but not necessarily act on now:**

- **[REPO]** The two `ORGANIZER` populations from the backfill
  (`1788900000000-BackfillBookingOrganizer.ts:24-27`) mean any change here must keep reading the frozen
  per-row value (`booking-email.ts:130`) rather than recomputing. That is already how it works; don't
  regress it.
- **[JUDGEMENT]** If RSVP is ever meant to be more than decorative, it needs an inbound path that parses
  `METHOD:REPLY` and `PARTSTAT` — none exists (`ics.ts:9` defines only `REQUEST`/`CANCEL`). Until then,
  the manage URL is the real reschedule/cancel mechanism and should be treated as the primary call to
  action in the customer email.

---

## Question 3 — purging the three files from git history

### 3.1 What I verified myself

**[REPO]** The commit: `956332a` ("fix(widget): rewire file upload to the endpoints that actually
exist", 2026-08-05) added, among nine changed files:

- `docs/Axentrio-App-Review-Submission-Packet.pdf` — 528,371 bytes
- `docs/handoff-composable-templates-enablement.md` — 78 lines
- `docs/meta-google-review-packet.md` — 304 lines

**[REPO]** The follow-up `97388e9` ("chore: untrack review packets committed by mistake", one minute
later) removed and gitignored all three. `git check-ignore -v` confirms they are ignored today via
`.gitignore:61`, `.gitignore:62`, `.gitignore:63`. Its own message already anticipated this question:
*"they remain in the history of 956332a — purging that requires a history rewrite of main, which is not
something to do unilaterally."*

**[REPO] Content — I checked the blobs, and the qualifier holds.** I extracted the PDF text with
`pdftotext` and read both Markdown files out of the commit. Findings:

- Every credential-shaped item is an **env-var name plus a blank**, e.g.
  `` | App Secret | `_______ (App Dashboard → Settings → Basic → App Secret; env META_APP_SECRET)` | ``,
  `` env MICROSOFT_CLIENT_SECRET — _______ ``,
  `` env GOOGLE_CLIENT_ID — _______ (Cloud Console → Credentials) ``.
- No high-entropy strings at all: a scan for any 28+ character alphanumeric run returned **zero** hits.
  Scans for `sk_live`/`sk_test`/`whsec_`/`AKIA`/`ghp_`/`xoxb-`/`-----BEGIN` returned nothing.
- The only email addresses in the packet are `privacy@axentrio.com` and `support@axentrio.com` —
  published support addresses.
- The one real identifier present is the Meta App ID `1548698999932589`. **[JUDGEMENT]** A Facebook App
  ID is a public identifier that ships in client-side login code by design; it is not a secret.
- **Correction to the record:** `97388e9`'s message says the files contain "reviewer test credentials".
  They do not. The document *instructs* the reader to create them — "A dedicated test Facebook account
  added as a Tester ... with known credentials — never submit personal Meta credentials" — and to
  "provide Tester credentials" to Meta. It is a checklist about credentials, not a file containing any.
  **[JUDGEMENT]** This matters for the decision: the belief that credentials leaked is the strongest
  argument for a rewrite, and it is not true.

**[REPO] Blast radius, measured:**

| Fact | Value | How checked |
|---|---|---|
| Repo visibility | **PUBLIC** | `gh repo view --json visibility` |
| Forks | **0** | `gh repo view --json forkCount` |
| Collaborators | **1** (`Axentrio`) | `gh api repos/.../collaborators` |
| Open PRs | **0** | `gh pr list --state open` |
| PRs total (all merged/closed) | 17, the newest merged 2026-08-03 | `gh pr list --state all` |
| PRs merged **after** `956332a` | **0** | same |
| Remote branches | **`main` only** | `git ls-remote --heads origin` |
| Tags | **0** | `git tag` |
| Local branches containing `956332a` | **1** (`main`) — of 26 local branches | `git branch --contains` |
| Commits after `956332a` on `main` | **10** | `git log 956332a..origin/main` |

**[JUDGEMENT]** The PR figure is the important one. GitHub's procedure has you count
`refs/pull/*/head` refs in `.git/filter-repo/changed-refs` because broken PR diffs are the main
irreversible cost. Since no PR was merged after `956332a` — the commit and its ten descendants were
pushed straight to `main` — that count should be **0**. This repo is about as cheap a rewrite target as
a public repo gets.

### 3.2 What GitHub officially recommends today

Source: *Removing sensitive data from a repository*
(https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).

**[VENDOR] On whether to rewrite at all — GitHub leads with this:**

> It is important to note that if the sensitive data you need to remove is a secret (e.g.
> password/token/credential), as is often the case, then as a first step you need to revoke and/or
> rotate that secret. Once the secret is revoked or rotated, it can no longer be used for access, and
> that may be sufficient to solve your problem. **Going through the extra steps to rewrite the history
> and remove the secret may not be warranted.**

**[VENDOR] Which tool.** The current page recommends `git-filter-repo` and nothing else:

> Install the latest release of [the `git-filter-repo` tool]. You need a version with the
> `--sensitive-data-removal` flag, meaning at least version 2.47.

with the command form

```
git-filter-repo --sensitive-data-removal --invert-paths --path PATH-TO-YOUR-FILE-WITH-SENSITIVE-DATA
```

**[VENDOR/SILENT] On `filter-branch` and BFG:** GitHub's current page does **not mention either**. It
does not compare them, does not deprecate them, does not recommend them. Older revisions of this page
did cover `filter-branch` and BFG; the page as published today does not. I am flagging this as an
absence I verified, not inferring a policy from it.

**[SPEC/VENDOR] git's own position on `filter-branch`** — `git-filter-branch(1)`
(https://git-scm.com/docs/git-filter-branch, source
https://raw.githubusercontent.com/git/git/master/Documentation/git-filter-branch.adoc):

> **WARNING**
>
> 'git filter-branch' has a plethora of pitfalls that can produce non-obvious manglings of the intended
> history rewrite (and can leave you with little time to investigate such problems since it has such
> abysmal performance). These safety and performance issues cannot be backward compatibly fixed and as
> such, **its use is not recommended**. Please use an alternative history filtering tool such as
> git filter-repo.

and on SHAs:

> *WARNING*! The rewritten history will have different object names for all the objects and will not
> converge with the original branch. You will not be able to easily push and distribute the rewritten
> branch on top of the original branch.

**[VENDOR] What a rewrite does NOT fix** — GitHub, verbatim:

> If you only rewrite your history and force push it, the commits with sensitive data may still be
> accessible elsewhere:
>
> * In any clones or forks of your repository
> * Directly via their SHA-1 hashes in cached views on GitHub
> * Through any pull requests that reference them
>
> You cannot remove sensitive data from other users' clones of your repository ...

and on forks specifically:

> If the commit that introduced the sensitive data exists in any forks, it will continue to be
> accessible there. You will need to coordinate with the owners of the forks ... GitHub cannot provide
> contact information for these owners.

**[VENDOR] Contacting Support.** GitHub says you *can* get the residue purged, with a stated limit:

> ... you can permanently remove cached views and references to the sensitive data in pull requests on
> GitHub by contacting GitHub Support.
>
> > [!IMPORTANT] GitHub Support won't remove non-sensitive data, and will only assist in the removal of
> > sensitive data in cases where we determine that the risk can't be mitigated by rotating affected
> > credentials.

If they accept, they will "Dereference or delete any affected PRs on GitHub", "Run a garbage collection
on the server to expunge the sensitive data from storage", and "Remove cached views."

**[JUDGEMENT]** Read that gate against §3.1: there are no credentials here, so there is nothing to
rotate, and the content is not sensitive data by GitHub's standard. On GitHub's own stated criteria,
**Support would be expected to decline.** That means the cached-views and PR-ref residue would remain
after a rewrite. Practically that residue is near-empty here (0 affected PR refs), but it should not be
assumed away.

**[VENDOR] Force-push is required, and what it does to collaborators:**

> Once you're happy with the state of your repository, force-push your local changes to overwrite your
> repository on GitHub. Even though `--force` is implied by `--mirror`, we include it below as a
> reminder that you are forcibly updating all branches, tags, and refs and you are discarding any
> changes others may have made to those refs while you were cleaning up the repository.
>
> ```
> git push --force --mirror origin
> ```
>
> This command will fail to push any refs starting with `refs/pull/`, since GitHub marks those as
> read-only.

> **High risk of recontamination**: It is unfortunately easy to re-push the sensitive data to the
> repository and make a bigger mess. If a fellow developer has a clone from before your rewrite, and
> after your rewrite simply runs `git pull` followed by `git push`, the sensitive data will return. They
> need to either discard their clone and re-clone, or carefully walk through multiple steps to clean up
> their clone first.

> **Changed commit hashes**: Rewriting history will change the hashes of the commits that introduced the
> sensitive data _and_ all commits that came after. Any tooling or automation that depends on commit
> hashes not changing will be broken or have problems.

> **Branch protection challenges**: If you have any branch protections that prevent force pushes, those
> protections will have to be turned off (at least temporarily).

> **Broken diff view for closed pull requests** ... **Poor interaction with open pull requests**:
> Changed commit SHAs will result in a different PR diff, and comments on the old PR diff may become
> invalidated and lost ... **We recommend merging or closing all open pull requests before removing files
> from your repository.**

> **Lost signatures on commits and tags**: ... `git-filter-repo` will remove commit signatures and tag
> signatures for commits that pre-date the sensitive data removal as well.

> **Leading others directly to the sensitive data**: ... when you do modify history, clueful users with
> an existing clone will notice the history divergence and can use it to quickly and easily find the
> sensitive data still in their clone that you removed from the central repository.

> Collaborators must rebase, _not_ merge, any branches they created off of your old (tainted) repository
> history. One merge commit could reintroduce some or all of the tainted history.

**[VENDOR] `git-filter-repo`'s own manual** (https://github.com/newren/git-filter-repo, man page source
https://raw.githubusercontent.com/newren/git-filter-repo/main/Documentation/git-filter-repo.txt),
"Sensitive Data Removals":

> Note that if the sensitive data under consideration is a token/password/credential/secret (as is often
> the case), then it is important that you revoke and rotate that credential first. ... Revoking/rotating
> may resolve your problem without resorting to the heavy-handed action of rewriting and purging history.

Its three high-level steps are "Rewrite the repository locally, using git-filter-repo" / "Make sure other
copies are cleaned up, including the server you cloned from [and] other clones that exist, such as ones
your colleagues made" / "Prevent repeats". It requires a **fresh clone** by default:

> abort if run from a repo that is not a fresh clone (to prevent people from accidentally losing local
> changes)

and is emphatic about not routinely bypassing that:

> it's perfectly fine to use `--force` to override the safety ... [but] it is definitely NOT okay to
> recommend `--force` on forums, Q&A sites, or ... `--force` means putting your repositories' data at
> risk.

It also warns that the force push "is likely to fail to push some refs, since most forges ... prevent
you from updating some refs (e.g. `refs/changes/*`, `refs/pull/*`, `refs/merge-requests/*`)", and that
anyone else working on the repo "should be instructed to stop while you do the cleanup".

Its verification commands, worth running afterwards:

```
git log --all --name-status -- ${PROBLEMATIC_FILE1} ${PROBLEMATIC_FILE2}
git log -S"${PROBLEMATIC_STRING}" --all -p --
```

### 3.3 Cost against benefit, for this repo specifically

**Concrete cost** [VENDOR-sourced where quoted, measured in §3.1]:

| Cost GitHub names | Actual size here |
|---|---|
| Every collaborator re-clones | **1 collaborator** (`Axentrio`), 1 working clone. One re-clone. |
| All SHAs from `956332a` forward change | **11 commits** (`956332a` + 10). |
| Open PRs break | **0 open PRs.** |
| Closed-PR diff views break | **0 PR refs in the affected range** — no PR merged after `956332a`. |
| Forks retain the data | **0 forks.** |
| Branch protection must be disabled | Only `main` exists remotely; check whether protection is on before starting. |
| Commit/tag signatures stripped | **0 tags.** Commits are unsigned in this repo. |
| Recontamination risk | Real but bounded: one clone, one branch (`main`) contains it; 25 of 26 local branches don't. |
| Residue GitHub Support would purge | **Support would likely decline** (no credentials → their stated gate not met). |
| Requires a fresh clone | Yes — and note the working tree currently holds untracked/ignored copies of all three files plus other untracked work; those must be preserved out-of-band. |

**Concrete benefit** [JUDGEMENT]:

- The public repo stops carrying a 528 KB internal review packet that maps the platform's entire
  integration surface: which env vars exist, which OAuth scopes are used, that the Google app is in
  Testing mode, that `META_OAUTH_JWT_SECRET` must be 32+ chars, and which files implement the webhook
  HMAC. None of that is a credential. All of it is reconnaissance material that shortens somebody
  else's homework, and none of it needs to be public.
- It removes a standing "is that actually clean?" question. Right now the untrack commit says
  "credentials" and the blobs say otherwise; anyone who re-reads the log will have to re-derive what I
  derived in §3.1.

**What it does *not* buy** [VENDOR, GitHub's list above]: nothing about anyone who already cloned or
crawled the repo between 2026-08-05 and now, and GitHub's own guidance is that a rewrite alone leaves
cached views and PR refs reachable by SHA.

### 3.4 Recommendation for Q3

**Do the rewrite — as hygiene, on the schedule of your choosing, and without treating it as an incident.**
[JUDGEMENT]

The reasoning, in order:

1. **The security case is nil**, and both GitHub and `git-filter-repo` say so in almost the same words:
   if it's a credential, rotate; rotation may make the rewrite unwarranted. Here there is nothing even
   to rotate. Do not represent this internally as a credential exposure — it isn't one, and the
   `97388e9` commit message should be corrected.
2. **The cost is genuinely, measurably near-zero for this repo, and it will never be lower.** 0 forks,
   1 collaborator, 0 open PRs, 0 affected PR refs, 1 branch on the remote, 0 tags. Every expensive item
   on GitHub's side-effects list evaluates to zero here. Each future merged PR and each future fork
   raises that number permanently.
3. **The residue is the part to be honest about.** GitHub Support is documented to decline non-sensitive
   data, so cached views and any SHA-addressable copies stay. With 0 affected PR refs that residue is
   small, but "purged from GitHub entirely" is not what you would be buying — "not in the default
   history anyone clones or browses" is.

Concretely, when you do it:

- Work from a **fresh clone** (`git-filter-repo` requires it) — and first move the untracked/ignored
  working-tree copies of the three files, and the other untracked work in `docs/`, somewhere safe.
- Use the documented command, one `--path` per file (all three were added at the same path they were
  removed from, so no rename paths are needed):
  `git-filter-repo --sensitive-data-removal --invert-paths --path docs/Axentrio-App-Review-Submission-Packet.pdf --path docs/handoff-composable-templates-enablement.md --path docs/meta-google-review-packet.md`
- Before the irreversible step, run GitHub's check —
  `grep -c '^refs/pull/.*/head$' .git/filter-repo/changed-refs` — and expect `0`. **If it isn't 0, stop
  and re-read**: GitHub notes you can still "discard this clone with no ill-effects" at that point, and
  `git-filter-repo`'s FAQ covers why more commits can be rewritten than expected.
- Verify with `git log --all --name-status -- <the three paths>` before pushing.
- Temporarily lift any branch protection on `main`, `git push --force --mirror origin`, restore it.
- Re-clone locally afterwards. Rebase — never merge — any of the 25 local branches that later need to
  reach the new `main`.
- Contacting Support is optional and likely to be declined; don't build the plan around it.
- Keep the `.gitignore` entries (`.gitignore:61-63`). GitHub's "avoiding accidental commits" section is
  worth acting on too: the root cause recorded in `97388e9` was "an over-broad `git add -A docs`", and
  GitHub explicitly advises "Avoid the catch-all commands `git add .` and `git commit -a`".

**The defensible alternative, stated fairly:** leave it. The files are ignored, the content is not
secret, GitHub's own framing says a rewrite "may not be warranted" when there is nothing to rotate, and
every rewrite carries the recontamination risk GitHub leads its side-effects list with. If you choose
this, choose it explicitly and fix the `97388e9` message so nobody later re-opens this on the false
premise that credentials are sitting in `956332a`. **[JUDGEMENT]** What is not defensible is the middle
state: believing the files are gone when they are one `git show 956332a` away.

---

## Appendix — primary sources used

**RFCs** (fetched from `rfc-editor.org`)
- RFC 5322, *Internet Message Format* — §3.6.2 originator fields — https://www.rfc-editor.org/rfc/rfc5322.txt
- RFC 5545, *iCalendar* — §3.2.18 `SENT-BY`, §3.8.1.7 `LOCATION`, §3.8.4.1 `ATTENDEE`, §3.8.4.3 `ORGANIZER` — https://www.rfc-editor.org/rfc/rfc5545.txt
- RFC 5546, *iTIP* — §2.1.3, §3.2.2.5, `METHOD:REQUEST` constraints, §6.1 threats — https://www.rfc-editor.org/rfc/rfc5546.txt
- RFC 6047, *iMIP* — §2.2.1, §2.3, §2.4, §3 — https://www.rfc-editor.org/rfc/rfc6047.txt
- RFC 7489, *DMARC* — §3.1 identifier alignment — https://www.rfc-editor.org/rfc/rfc7489.txt
- RFC 9073, *Event Publishing Extensions to iCalendar* — `VLOCATION`, `STRUCTURED-DATA`, `LOCATION-TYPE` — https://www.rfc-editor.org/rfc/rfc9073.txt

**Vendor documentation**
- Google Calendar API, Events resource — https://developers.google.com/workspace/calendar/api/v3/reference/events
- Google Calendar API, *Invite users to an event* — https://developers.google.com/workspace/calendar/api/concepts/inviting-attendees-to-events
- Google, *Email sender guidelines* — https://support.google.com/mail/answer/81126
- Microsoft Graph, `event` resource — https://learn.microsoft.com/en-us/graph/api/resources/event
- Microsoft Graph, `location` resource — https://learn.microsoft.com/en-us/graph/api/resources/location
- `[MS-OXCICAL]` Property: `METHOD` — https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/7befe35d-0652-447f-a780-d5fd5b879d38
- `[MS-OXCICAL]` Property: `ORGANIZER` — https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-oxcical/088b8ca4-199c-4a93-bd5f-590dc9126319
- `[MS-STANOICAL]` V0258, RFC 5546 §3.2.2.5 — https://learn.microsoft.com/en-us/openspecs/exchange_standards/ms-stanoical/374c8a03-e309-494e-be48-1d6191a5889f
- Apple, *Add location and travel time to events in Calendar on Mac* — https://support.apple.com/guide/calendar/add-location-and-travel-time-to-events-icl43600/mac
- Resend, *Domains* — https://resend.com/docs/dashboard/domains/introduction
- Resend, *Send Email* — https://resend.com/docs/api-reference/emails/send-email
- Resend, *Create Domain* — https://resend.com/docs/api-reference/domains/create-domain

**Git / GitHub**
- GitHub, *Removing sensitive data from a repository* — https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository
- `git-filter-branch(1)` — https://git-scm.com/docs/git-filter-branch
- `git-filter-repo` man page — https://github.com/newren/git-filter-repo (Documentation/git-filter-repo.txt)

**Regulation**
- Regulation (EU) 2016/679 (GDPR), Recital 14, Art. 4(1), Art. 4(2), Art. 5(1)(c), Art. 5(1)(d), Art. 25(2) — https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32016R0679

**Deliberately excluded:** Google/Microsoft community forum threads, Stack Overflow, and vendor-adjacent
blog posts. Where they were the only material available — Gmail RSVP rendering conditions,
`X-APPLE-STRUCTURED-LOCATION` — this document records a gap instead.

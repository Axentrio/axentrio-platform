# Customer language and business language are separate audiences

Axentrio now treats **who reads the message** as the language decision, not **where the setting lives in the portal**.

Every customer-facing surface — booking confirmation emails, reminders, ICS descriptions, and the self-service manage page — renders through `getBookingCopy(customerLanguage)`. The customer language is stored on `Booking.customer_language`, reported by the model at booking time, and falls back to the Agent's default reply language when absent.

Every internal notification — owner booking emails, request alerts, new-lead automations, and owner calendar event labels — renders through `getBookingCopy(ownerLanguage)`. The business language is `Tenant.settings.businessLanguage` when set; otherwise `resolveOwnerLanguage` walks the existing chain (support mailbox locale, oldest admin locale, onboarding language, English). `en`, `nl`, and `fr` ship static catalogs so a failed translator cannot leave the owner's calendar in English. The LLM path is only for an unexpected language.

Customer **free text** inside internal mail is translated into the business language with `translateFreeText`, and the customer's original words are kept underneath `owner.original_heading`. Structured values — service names, times, prices, phone numbers, addresses, reference codes, URLs — are never passed through a model. Calendar labels (`event.*`) come from the owner's catalog; customer notes in the mirror stay in the customer's own words.

The resolver lives in `api/src/i18n/audience-language.ts` so Leads and future modules share one seam instead of each inventing its own guess.

## Consequences

Two settings can legitimately differ: a Dutch customer and an English-speaking owner team is normal, not a misconfiguration.
Translating customer notes for the owner does not rewrite those notes on the calendar mirror. Event title and field labels still follow the business language.
A missing or invalid `businessLanguage` falls through silently to the legacy chain — no tenant is blocked from saving other settings.

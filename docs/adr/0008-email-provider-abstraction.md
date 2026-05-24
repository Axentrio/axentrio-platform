# Email sending goes through a provider abstraction (mirroring billing)

All transactional and digest email — starting with the Insights v1 weekly digest — sends through an `EmailProvider` interface registered in `email/provider-registry.ts`, following the same pattern as `billing/provider-registry.ts`. Concrete providers live in `email/providers/` (initial implementation: `ResendEmailProvider`). `EmailService` becomes a thin façade that resolves the active provider from the registry and delegates — callers never import a vendor SDK directly.

The existing `EmailService` (`api/src/automations/email.service.ts`) already exposes a vendor-neutral `SendEmailOptions` / `SendEmailResult` shape, so the public contract is already correct; the work is internal — extract the Resend instantiation and error/data shape leakage behind the interface.

We chose abstraction over direct Resend SDK calls because the SMB platform is likely to need provider portability (regional sending, deliverability fallback, tenant-supplied SMTP for white-label, eventual SES for cost) and these all become file-add operations rather than refactors. The trade-off is one extra indirection layer and the cost of writing a provider per vendor — small relative to the cost of ripping out Resend across N call sites later.

Insights v1 weekly digest, handoff notifications, billing receipts, password resets — all route through this abstraction. Anything that needs vendor-specific features (Resend audiences, scheduled sends) gets an extension method on the provider interface, not a leak of the SDK into application code.

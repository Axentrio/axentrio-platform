---
slug: invoice-and-billing
title: Finding invoices and billing details
locale: en
tags:
  - billing
  - invoices
  - payment
---

# Invoice and billing

All billing actions are under *Settings → Billing*.

**Finding invoices:** *Settings → Billing → Invoices*. The list shows every invoice with date, amount, and status. Click any row to open the PDF or download the receipt.

**Failed payments:** if a charge fails (expired card, declined transaction), you get a daily email for 3 days and an in-portal banner. Stripe still retries the charge automatically — no need to manually re-trigger. If the invoice is still unpaid at day 3, we cancel the subscription and the workspace drops to Free. Update your card under *Settings → Billing → Payment method*.

**Updating payment method:** *Settings → Billing → Payment method*. Stripe's secure form opens — change card, submit. Existing scheduled payments use the new card.

**Changing billing email:** *Settings → Billing → Billing email*. This is separate from your login email — receipts and invoices go to the billing email.

**VAT / tax IDs:** add your VAT number under *Settings → Billing → Tax details*. Future invoices include it.

**Currency:** invoices are in EUR for European tenants, USD for the rest. Currency is set at signup and doesn't change later.

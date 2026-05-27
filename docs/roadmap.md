# Chatbot Platform — Improvement Roadmap

> High-level plan for platform improvements, organized by phase.
> Each phase gets its own brainstorming → spec → plan → implementation cycle.

---

## Phase 1: Finish Admin Gaps *(Completed 2026-03-26)*

1. ~~Member deactivation/reactivation UI~~
2. ~~Pending invites management (list, resend, cancel)~~
3. ~~Tenant detail page (`/admin/tenants/:id`)~~
4. ~~Dedicated audit log viewer with filters, pagination, and CSV export~~

---

## Phase 2: Testing & Reliability

5. **Automated tests** — Unit tests for services, integration tests for API routes, E2E tests for critical flows (chat, handoff, file upload)
6. **Error monitoring** — Integrate Sentry or similar for runtime error tracking (currently only Winston file logging)
7. **Database backups** — Automated Railway DB backup strategy

---

## Phase 3: Chat Experience Improvements

8. **Canned responses** — Pre-defined quick replies for agents to speed up response time
9. **Chat routing rules** — Auto-assign chats based on agent skills/languages/availability instead of manual queue pickup
10. **Conversation tags & notes** — Let agents tag and annotate conversations for better categorization
11. **Customer context panel** — Show visitor history (previous sessions, pages visited) alongside active chat

---

## Phase 4: Analytics & Reporting

12. **Agent leaderboard** — Compare agent performance (response time, CSAT, volume)
13. **SLA tracking** — Define response time targets per tenant tier, alert on breaches
14. **Exportable reports** — Scheduled PDF/CSV reports for tenant admins
15. **Funnel analytics** — Track bot-to-handoff conversion, resolution rates, abandonment

---

## Phase 5: Widget & Customer-Facing

16. **Widget theming editor** — Visual UI in the portal to customize widget colors, position, greeting messages without code
17. **Pre-chat form** — Collect name/email before starting a session (configurable per tenant)
18. **Offline mode** — Show a contact form when no agents are online instead of dead chat
19. **Multi-language widget** — i18n support for widget UI strings

---

## Phase 6: Platform & Infrastructure

20. **Notification system** — Email/push notifications for agents on new handoffs, missed chats
21. **API rate limit dashboard** — Show tenants their API usage and limits
22. **Tenant billing integration** — Connect to Stripe for subscription management based on tier
23. **Webhook event log UI** — Let tenants see their n8n webhook delivery history and retry failures
24. **Knowledge base / FAQ bot** — Built-in FAQ system that the bot can search before escalating to human

---

## Phase 7: Security & Compliance

25. **GDPR data export** — Allow visitors to request their conversation data
26. **IP allowlisting** — Per-tenant IP restrictions for portal access
27. **Session recording consent** — Configurable consent banners before chat starts
28. **Penetration test fixes** — Run a security audit and address findings

---

## Priority Order

Phase 1 → Phase 2 → Phase 3 is the recommended sequence. Finishing admin gaps unblocks daily operations, tests prevent regressions as you build, and chat experience improvements are the core value proposition. Later phases can be reordered based on business priorities.

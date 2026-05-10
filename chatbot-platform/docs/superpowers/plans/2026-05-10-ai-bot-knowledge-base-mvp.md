# AI Bot and Knowledge Base MVP Plan

**Date:** 2026-05-10

**Goal:** Make the first version of AI setup understandable for non-technical business users. The MVP should help users configure the chatbot, add knowledge, and test the result without requiring them to understand providers, models, API keys, or prompt engineering.

**Primary next-pass scope:** AI Bot page and Knowledge Base page.

**Already completed baseline:** The six-tab AI & Content header has been implemented and confirmed working.

**Deferred content scope:** Chatbot Appearances, Social Media Integrations, and Extra Settings have visible placeholder tabs, but their real settings content is not part of the immediate next pass.

---

## Product Direction

The MVP should answer three user questions:

1. What is my chatbot called?
2. What should it do and how should it sound?
3. What information should it use to answer customers?

The AI Bot page handles questions 1 and 2. The Knowledge Base page handles question 3.

Provider configuration should not be user-facing in this MVP. OpenAI/provider/model/API key settings are platform-managed through environment configuration and backend defaults.

---

## Current Repo Notes

Relevant frontend files:

- `portal/src/pages/AiContent.tsx`
- `portal/src/pages/knowledge/AiBotForm.tsx`
- `portal/src/pages/knowledge/aiBotTemplates.ts`
- `portal/src/pages/knowledge/DocumentsTab.tsx`

Relevant backend files:

- `api/src/llm/prompt-builder.ts`
- `api/src/__tests__/unit/prompt-builder.test.ts`

Current observations:

- `AiBotForm.tsx` already has the main shape needed for this MVP: bot name, support email, tone pills, template selector, editable instructions textarea, flat advanced settings, and a `Go to Knowledge Base` button.
- `aiBotTemplates.ts` already has starter templates, but the list should be adjusted to match the MVP categories.
- `DocumentsTab.tsx` already has document filtering, search, empty states, upload/edit modal behavior, retry, and delete.
- `DocumentsTab.tsx` still uses provider-oriented setup copy. That should change because provider setup is platform-managed.
- `AiContent.tsx` has the accepted six-tab version in the working tree: `AI Bot`, `Knowledge base`, `Custom Responses`, `Chatbot Appearances`, `Social Media Integrations`, and `Extra Settings`.
- The new `appearances`, `social`, and `extra` tabs deep-link correctly and render placeholder panels. Keep that behavior.
- `prompt-builder.ts` currently lets tenant custom instructions replace the full base prompt. This is acceptable for a short UI pass, but it should be hardened before relying heavily on templates.

---

## Completed Navigation Baseline

The tab-header pass is done and should be preserved:

- `AI Bot`
- `Knowledge base`
- `Custom Responses`
- `Chatbot Appearances`
- `Social Media Integrations`
- `Extra Settings`

Confirmed behavior:

- Tabs render in the requested order.
- Active tab highlight works.
- URL sync works, including deep links such as `?tab=appearances`.
- Existing route key `canned` is preserved for Custom Responses, so existing links do not break.
- Placeholder content renders cleanly for future tabs.

Next-pass rule:

- Do not revisit tab structure unless a bug appears.
- Keep the future tabs as placeholders.
- Focus implementation work on AI Bot and Knowledge Base.

---

## AI Bot Page

### Keep

- Page header: `AI & Content` and the existing subtitle.
- `Test Chat` button.
- AI Bot enable toggle card.
- Chatbot name field.
- Support email field.
- Voice tone pills, including a custom tone input.
- Advanced settings, with all current guardrail fields preserved.
- Blue `Go to Knowledge Base` button.

### Remove From User-Facing UI

- Provider selector.
- Model selector.
- API key input.
- Test connection button.

These are platform concerns, not tenant setup concerns.

### Rename and Reframe Prompt UI

Avoid showing `Base System Prompt` to users. Use product language:

- Section title: `Bot Instructions`
- Helper text: `Tell the chatbot how it should answer visitors. You can start from a template and edit it.`
- Template label: `Choose a starter prompt`
- Textarea placeholder: `Describe what your chatbot should do, what it should avoid, and when it should ask for help.`

This keeps the power of templates while avoiding prompt-engineering language.

### Starter Prompt Templates

Start with a practical, short list:

- `General Website Assistant`
- `Customer Support Assistant`
- `Lead Qualification Agent`
- `Ecommerce Product Recommendation Agent`
- `Service Business Quote Agent`
- `Restaurant Reservation Agent`
- `Real Estate Sales Agent`
- `Booking Assistant`

Template behavior:

- Selecting a template fills the Bot Instructions textarea.
- The inserted text is editable.
- `Reset` restores the currently selected template.
- If the user has edited the textarea and selects a different template, warn before replacing their work.
- The template selector is a starter helper, not a locked mode.

### Suggested AI Bot Layout

1. Enable AI Bot toggle.
2. Bot Identity:
   - Chatbot Name
   - Helper text: `Chatbot display name for users to see on the website.`
   - Support Email
3. Bot Instructions:
   - Choose a starter prompt
   - Editable instructions textarea
   - Reset action
4. Voice Tone:
   - Friendly
   - Professional
   - Casual
   - Formal
   - Custom
5. Advanced Settings:
   - Greeting message
   - Fallback message
   - Off-hours message
   - Confidence threshold
   - Max response length
   - Escalation keywords
   - Topics to avoid
6. Footer actions:
   - `Go to Knowledge Base`
   - `Save Changes`

### Save and Navigation Behavior

The `Go to Knowledge Base` button must not silently discard edits.

Recommended MVP behavior:

- If the form is clean, navigate directly to Knowledge Base.
- If the form has unsaved changes, show a confirmation before navigating.
- Keep `Save Changes` visible and disabled while saving.

Do not auto-save from `Go to Knowledge Base` in the first pass. A navigation button that silently triggers a save can fail in confusing ways; a confirmation is simpler and more predictable for the MVP.

---

## Knowledge Base Page

### Keep

- Document upload/add flow.
- Paste text / FAQ / document source support, if already implemented.
- Document cards.
- Processing, indexed, and failed statuses.
- Search and filter controls.
- Empty state.
- Retry and delete actions for admins.

### Update Copy

Avoid provider language here too.

Current problematic copy:

- `AI bot is not configured - documents won't be used for responses until you set up a provider.`

Recommended copy:

- `AI Bot is not enabled yet. Turn it on so these documents can be used in visitor replies.`

Button copy:

- `Configure AI Bot`

### Knowledge Base MVP Flow

1. User opens Knowledge Base.
2. If there are no documents, show a clear empty state:
   - `No documents yet`
   - `Upload PDFs, paste text, or add FAQs so your AI bot can answer from your business information.`
3. User adds a document.
4. Document shows processing status.
5. When indexed, document becomes available to the AI bot.
6. User can return to AI Bot and test with `Test Chat`.

---

## Prompt Architecture

The product UI should expose `Bot Instructions`, but the backend should still protect platform behavior.

Recommended final prompt composition:

1. Platform system rules controlled by the app.
2. Tenant Bot Instructions from the AI Bot page.
3. Tenant tone and guardrails.
4. Knowledge Base context retrieved for the current conversation.
5. Channel/session context.

Important rule:

- User-editable Bot Instructions should not replace platform system rules.

Current implementation note:

- `api/src/llm/prompt-builder.ts` currently treats `brandVoice.customInstructions` as the full base prompt when present.
- For the MVP UI, this can work short term.
- Before scaling templates, refactor prompt building so tenant instructions are composed under platform rules instead of replacing them.

---

## Implementation Plan

### Phase 0: Preserve Completed Navigation Baseline

Files:

- `portal/src/pages/AiContent.tsx`

Tasks:

- Keep the accepted six-tab header unchanged unless a bug appears.
- Preserve route/query compatibility, especially the existing `canned` route key for Custom Responses.
- Keep `Chatbot Appearances`, `Social Media Integrations`, and `Extra Settings` as placeholder tabs until their real content is scheduled.
- Do not spend the next pass on tab structure.

### Phase 1: AI Bot Copy and Layout

Files:

- `portal/src/pages/knowledge/AiBotForm.tsx`

Tasks:

- Rename `Base System Prompt` to `Bot Instructions`.
- Replace system-prompt helper text with user-friendly copy.
- Update Chatbot Name helper text.
- Rename local frontend variables from `systemPrompt` to `botInstructions` only if the file is already being touched heavily; backend storage can continue using `brandVoice.customInstructions` for now.
- Keep advanced settings flat and visible, not hidden in accordions.
- Remove any provider/model/API key UI if still present.

### Phase 2: Starter Prompt Templates

Files:

- `portal/src/pages/knowledge/aiBotTemplates.ts`
- `portal/src/pages/knowledge/AiBotForm.tsx`

Tasks:

- Rename template selector copy to `Choose a starter prompt`.
- Add the MVP template list.
- Keep templates editable after insertion.
- Add dirty-state protection before replacing edited instructions.
- Keep reset behavior tied to the selected template.

### Phase 3: Save/Navigation Safety

Files:

- `portal/src/pages/knowledge/AiBotForm.tsx`
- `portal/src/pages/AiContent.tsx`

Tasks:

- Track whether the AI Bot form has unsaved changes.
- Prevent `Go to Knowledge Base` from losing unsaved edits.
- Show a confirmation before navigating away with unsaved edits.

### Phase 4: Knowledge Base Copy and Empty State

Files:

- `portal/src/pages/knowledge/DocumentsTab.tsx`

Tasks:

- Replace provider-based setup copy.
- Keep document status, filters, upload, retry, and delete behavior.
- Ensure the empty state explains that documents power chatbot answers.

### Phase 5: Backend Prompt Safety

Files:

- `api/src/llm/prompt-builder.ts`
- `api/src/__tests__/unit/prompt-builder.test.ts`

Tasks:

- Compose platform rules and tenant instructions instead of allowing tenant instructions to replace the full system prompt.
- Preserve placeholder substitution.
- Add tests for:
  - tenant instructions are included
  - platform rules remain present
  - unknown placeholders are preserved
  - no provider secrets are inserted

### Phase 6: Verification

Run:

```bash
cd chatbot-platform/portal
npm run build
```

```bash
cd chatbot-platform/api
npm test -- src/__tests__/unit/prompt-builder.test.ts
```

Manual checks:

- Toggle AI Bot on/off.
- Pick a starter prompt.
- Edit instructions.
- Try switching templates after editing.
- Save changes.
- Navigate to Knowledge Base.
- Add a document.
- Confirm empty, processing, failed, and indexed states still render.
- Open Test Chat and verify it uses the configured bot name and instructions.

---

## Acceptance Criteria

- Non-technical users never need to see provider/model/API key fields.
- The page says `Bot Instructions`, not `Base System Prompt`.
- Users can choose a starter prompt and edit it.
- Users are protected from accidentally overwriting edited instructions.
- Chatbot Name helper text says it is the display name users see on the website.
- Voice tone supports preset and custom tone.
- Advanced settings are visible on the page, not hidden behind accordions.
- `Go to Knowledge Base` is visible and blue.
- Unsaved AI Bot edits are not silently lost when navigating.
- Knowledge Base copy does not mention setting up a provider.
- Documents clearly show whether they are ready to power chatbot replies.

---

## Review Passes

### Pass 1: Product Scope

Decision: Focus MVP on AI Bot and Knowledge Base first.

Result:

- Deferred tab content is treated as roadmap work, while the completed six-tab header remains visible.
- Provider configuration is removed from user-facing setup.
- The setup flow maps cleanly to the user's immediate job: name the bot, tell it what to do, add knowledge, and test.

### Pass 2: UX Clarity

Decision: Replace prompt-engineering language with business-user language.

Result:

- `Base System Prompt` becomes `Bot Instructions`.
- Templates are framed as starter prompts, not technical presets.
- Advanced settings stay visible because hiding them behind accordions makes features harder to discover.
- Navigation to Knowledge Base includes unsaved-change protection.

### Pass 3: Engineering Safety

Decision: Keep templates in the frontend, but protect platform behavior in the backend prompt builder.

Result:

- Template selection remains a UI helper.
- Tenant instructions should be composed with platform system rules.
- Prompt-builder tests are required before changing backend prompt composition.
- Existing query routes and settings storage can be reused for the MVP.

### Pass 4: Implementation Order

Decision: Ship the smallest coherent product path first.

Result:

1. Preserve the completed six-tab navigation baseline.
2. Improve AI Bot labels and layout.
3. Improve starter templates and dirty-state behavior.
4. Improve Knowledge Base copy.
5. Harden backend prompt composition.
6. Verify with build, targeted tests, and manual setup flow.

---

## Resolved Decisions

- **Persistence of starter template:** Save **both** the instruction text and the selected `templateId`. Instruction text is the source of truth; `templateId` is a soft reference used for "Modified from <Template>" badges, future template-version diffs, and adoption analytics. If the referenced template is later deleted or renamed, the saved text still wins — the stale ID is tolerated, not enforced.
- **FAQs surface:** The `FAQs` action next to the starter prompt selector opens an **in-app drawer** with short, UI-coupled guidance ("what does Voice Tone do?", "what placeholders are available?"). External documentation links remain for deeper prompt-engineering guides only. Keeps in-app content focused and reduces drift between docs and UI.

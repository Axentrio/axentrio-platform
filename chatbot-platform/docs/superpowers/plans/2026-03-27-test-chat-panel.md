# Test Chat Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slide-over test chat panel in the Knowledge Base AI Settings tab so admins can converse with their configured AI bot using saved settings, with optional knowledge base retrieval.

**Architecture:** New `POST /tenants/me/ai-settings/test-chat` endpoint that accepts conversation history and a KB toggle. Frontend slide-over panel with widget-replica chat bubbles, typing indicator, and auto-scroll. Uses saved tenant AI settings (not inline form values). Ephemeral — no DB persistence.

**Tech Stack:** React, TypeScript, shadcn/ui, TanStack Query (mutation), Tailwind CSS, existing ChatWindow bubble styles, existing TypingIndicator component.

**Spec:** `docs/superpowers/specs/2026-03-27-test-chat-panel-design.md`

---

### Task 1: Add Backend Test Chat Endpoint

**Files:**
- Modify: `api/src/schemas/ai-settings.schema.ts`
- Modify: `api/src/knowledge/knowledge.controller.ts`
- Modify: `api/src/knowledge/ai-settings.routes.ts`

- [ ] **Step 1: Add test chat schema**

In `chatbot-platform/api/src/schemas/ai-settings.schema.ts`, add after the existing `testAiSettingsSchema`:

```typescript
export const testChatSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).max(50).default([]),
  useKnowledgeBase: z.boolean().default(false),
});
```

- [ ] **Step 2: Add test chat controller function**

In `chatbot-platform/api/src/knowledge/knowledge.controller.ts`, add after the `testAiSettings` function:

```typescript
export async function testChat(req: Request, res: Response) {
  const tenantId = (req as any).tenantId;
  const { message, history, useKnowledgeBase } = testChatSchema.parse(req.body);
  const tenantRepo = AppDataSource.getRepository(Tenant);
  const tenant = await tenantRepo.findOneOrFail({ where: { id: tenantId } });

  const ai = tenant.settings?.ai;
  if (!ai?.enabled) {
    res.status(400).json({ error: 'AI is not enabled. Save your AI settings first.' });
    return;
  }

  if (useKnowledgeBase) {
    // Full RAG pipeline — requires OPENAI_API_KEY for embeddings
    const result = await generateResponse(AppDataSource, tenantId, ai, message, history);
    res.json({
      response: result.response,
      provider: ai.provider,
      model: ai.model,
      confidence: result.confidence,
      chunksUsed: result.chunks.length,
    });
  } else {
    // LLM-only with brand voice and guardrails
    const { getProvider } = await import('../llm/provider-factory');
    const provider = getProvider(ai.provider, ai.apiKey);

    const systemPrompt = `You are ${ai.brandVoice.name}.
Tone: ${ai.brandVoice.tone}
${ai.brandVoice.customInstructions}

Rules:
- Never discuss: ${ai.guardrails.topicsToAvoid.join(', ') || 'N/A'}
- Max response: ${ai.guardrails.maxResponseLength} characters
- If you cannot help, say: "${ai.guardrails.fallbackMessage}"`;

    const messages = [
      { role: 'system' as const, content: systemPrompt },
      ...history.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      { role: 'user' as const, content: message },
    ];

    const response = await provider.chat(messages, {
      model: ai.model,
      maxTokens: 1000,
      temperature: 0.3,
    });

    res.json({
      response: response.content,
      provider: ai.provider,
      model: ai.model,
    });
  }
}
```

- [ ] **Step 3: Add import for testChatSchema**

At the top of `chatbot-platform/api/src/knowledge/knowledge.controller.ts`, add `testChatSchema` to the import:

```typescript
import { updateAiSettingsSchema, testAiSettingsSchema, testChatSchema } from '../schemas/ai-settings.schema';
```

- [ ] **Step 4: Add route**

In `chatbot-platform/api/src/knowledge/ai-settings.routes.ts`, add after the existing test route:

```typescript
router.post('/ai-settings/test-chat', requireRole('admin'), asyncHandler(ctrl.testChat));
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd chatbot-platform/api && npx tsc --noEmit
```

Expected: no new errors (pre-existing socket.handler error is fine).

- [ ] **Step 6: Commit**

```bash
git add chatbot-platform/api/src/schemas/ai-settings.schema.ts chatbot-platform/api/src/knowledge/knowledge.controller.ts chatbot-platform/api/src/knowledge/ai-settings.routes.ts
git commit -m "feat: add test-chat endpoint with conversation history and KB toggle"
```

---

### Task 2: Add Frontend Test Chat Mutation

**Files:**
- Modify: `portal/src/queries/useKnowledgeQueries.ts`

- [ ] **Step 1: Add useTestChat mutation**

In `chatbot-platform/portal/src/queries/useKnowledgeQueries.ts`, add after the `useTestAiSettings` function:

```typescript
interface TestChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface TestChatResponse {
  response: string;
  provider: string;
  model: string;
  confidence?: number;
  chunksUsed?: number;
}

export function useTestChat() {
  return useMutation({
    mutationFn: (data: { message: string; history: TestChatMessage[]; useKnowledgeBase: boolean }) =>
      api.post<TestChatResponse>('/tenants/me/ai-settings/test-chat', data),
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add chatbot-platform/portal/src/queries/useKnowledgeQueries.ts
git commit -m "feat: add useTestChat mutation hook"
```

---

### Task 3: Build TestChatPanel Component

**Files:**
- Create: `portal/src/pages/knowledge/TestChatPanel.tsx`

- [ ] **Step 1: Create TestChatPanel component**

Create `chatbot-platform/portal/src/pages/knowledge/TestChatPanel.tsx`:

```tsx
import React, { useState, useRef, useEffect } from 'react';
import { X, Send, Bot, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { CompactTypingIndicator } from '@/components/TypingIndicator';
import { useTestChat } from '@/queries/useKnowledgeQueries';

interface TestChatPanelProps {
  isOpen: boolean;
  onClose: () => void;
  botName: string;
  provider: string;
  model: string;
  hasIndexedDocs: boolean;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const TestChatPanel: React.FC<TestChatPanelProps> = ({
  isOpen,
  onClose,
  botName,
  provider,
  model,
  hasIndexedDocs,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [useKB, setUseKB] = useState(hasIndexedDocs);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const testChat = useTestChat();

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setMessages([]);
      setInput('');
      setUseKB(hasIndexedDocs);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, hasIndexedDocs]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, testChat.isPending]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || testChat.isPending) return;

    const userMsg: ChatMessage = { role: 'user', content: trimmed };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput('');

    const history = updatedMessages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    testChat.mutate(
      {
        message: trimmed,
        history: history.slice(0, -1), // exclude the current message
        useKnowledgeBase: useKB,
      },
      {
        onSuccess: (data) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const resp = data as any;
          const botMsg: ChatMessage = { role: 'assistant', content: resp.response };
          setMessages((prev) => [...prev, botMsg]);
        },
        onError: () => {
          const errMsg: ChatMessage = {
            role: 'system',
            content: 'Something went wrong. Check your API key and model configuration.',
          };
          setMessages((prev) => [...prev, errMsg]);
        },
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-[400px] bg-surface-0 border-l border-edge z-50 flex flex-col shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-full bg-primary-600/20 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4 text-primary-400" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{botName || 'AI Assistant'}</p>
              <p className="text-xs text-text-muted">{provider} / {model}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} className="flex-shrink-0">
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* KB Toggle */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-edge bg-surface-1">
          <span className="text-xs text-text-muted">Use Knowledge Base</span>
          <div className="flex items-center gap-2">
            {!hasIndexedDocs && useKB && (
              <span className="text-xs text-amber-400">No indexed docs</span>
            )}
            <Switch checked={useKB} onCheckedChange={setUseKB} />
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-12 h-12 rounded-full bg-surface-2 flex items-center justify-center mb-3">
                <Bot className="w-6 h-6 text-text-muted" />
              </div>
              <p className="text-sm text-text-muted">Send a message to test your bot</p>
              <p className="text-xs text-text-muted mt-1">Using saved AI settings</p>
            </div>
          )}

          {messages.map((msg, i) => {
            if (msg.role === 'system') {
              return (
                <div key={i} className="flex justify-center">
                  <p className="text-xs text-red-400 bg-red-400/10 px-3 py-1.5 rounded-lg">
                    {msg.content}
                  </p>
                </div>
              );
            }

            const isUser = msg.role === 'user';
            return (
              <div key={i} className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isUser
                    ? 'bg-surface-3 text-text-secondary'
                    : 'bg-primary-600/20 text-primary-400'
                }`}>
                  {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                </div>
                <div className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm whitespace-pre-wrap ${
                  isUser
                    ? 'bg-primary-600 text-white rounded-br-md'
                    : 'bg-surface-3 text-text-primary rounded-bl-md'
                }`}>
                  {msg.content}
                </div>
              </div>
            );
          })}

          {testChat.isPending && (
            <div className="flex gap-2 flex-row">
              <div className="w-7 h-7 rounded-full bg-primary-600/20 flex items-center justify-center flex-shrink-0">
                <Bot className="w-3.5 h-3.5 text-primary-400" />
              </div>
              <CompactTypingIndicator />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-edge">
          <div className="flex gap-2">
            <Input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              disabled={testChat.isPending}
              className="flex-1"
            />
            <Button
              onClick={handleSend}
              disabled={!input.trim() || testChat.isPending}
              size="icon"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};

export default TestChatPanel;
```

- [ ] **Step 2: Commit**

```bash
git add chatbot-platform/portal/src/pages/knowledge/TestChatPanel.tsx
git commit -m "feat: add TestChatPanel slide-over component"
```

---

### Task 4: Integrate Panel into AI Settings Tab

**Files:**
- Modify: `portal/src/pages/knowledge/AiSettingsTab.tsx`

- [ ] **Step 1: Add imports and state**

In `chatbot-platform/portal/src/pages/knowledge/AiSettingsTab.tsx`, add to the imports:

```typescript
import { MessageSquare } from 'lucide-react';
import TestChatPanel from './TestChatPanel';
import { useKnowledgeStats } from '@/queries/useKnowledgeQueries';
```

- [ ] **Step 2: Add panel state and stats query**

Inside the `AiSettingsTab` component, after the existing state declarations, add:

```typescript
const [isTestChatOpen, setIsTestChatOpen] = useState(false);
const { data: stats } = useKnowledgeStats();
const hasIndexedDocs = parseInt(stats?.documents?.indexed || '0') > 0;
```

- [ ] **Step 3: Add Test Chat button next to the AI Bot toggle**

Replace the AI Bot toggle section. Find:

```tsx
      <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-surface-3">
            <FlaskConical className="w-4 h-4 text-primary-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">AI Bot</p>
            <p className="text-xs text-text-muted">Enable AI-powered responses for visitors</p>
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} disabled={readOnly} />
      </div>
```

Replace with:

```tsx
      <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-surface-3">
            <FlaskConical className="w-4 h-4 text-primary-400" />
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">AI Bot</p>
            <p className="text-xs text-text-muted">Enable AI-powered responses for visitors</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {isAdmin && aiSettings?.enabled && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsTestChatOpen(true)}
            >
              <MessageSquare className="w-4 h-4 mr-2" />
              Test Chat
            </Button>
          )}
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={readOnly} />
        </div>
      </div>
```

- [ ] **Step 4: Render the panel**

At the very end of the component's return JSX, just before the closing `</div>`, add:

```tsx
      {isAdmin && (
        <TestChatPanel
          isOpen={isTestChatOpen}
          onClose={() => setIsTestChatOpen(false)}
          botName={aiSettings?.brandVoice?.name || 'AI Assistant'}
          provider={aiSettings?.provider || 'openai'}
          model={aiSettings?.model || ''}
          hasIndexedDocs={hasIndexedDocs}
        />
      )}
```

- [ ] **Step 5: Verify in browser**

Navigate to `http://localhost:4080/knowledge` → AI Settings tab. With AI Bot enabled and settings saved, click "Test Chat". Panel should slide in from the right. Send a message and verify you get a response.

- [ ] **Step 6: Commit**

```bash
git add chatbot-platform/portal/src/pages/knowledge/AiSettingsTab.tsx
git commit -m "feat: integrate Test Chat panel into AI Settings tab"
```

---

### Task 5: Build Verification

**Files:** None (verification only)

- [ ] **Step 1: Run TypeScript build**

```bash
cd chatbot-platform/portal && npx tsc --noEmit
```

Expected: no new errors from our changes.

- [ ] **Step 2: Manual smoke test**

1. Navigate to Knowledge Base → AI Settings
2. Ensure AI Bot is enabled and settings are saved
3. Click "Test Chat" — panel slides in from right
4. Send a message — bot responds with brand voice
5. Toggle "Use Knowledge Base" on — if no docs indexed, shows amber warning
6. Toggle KB off, send another message — multi-turn conversation works
7. Close panel, reopen — conversation is reset
8. Click outside panel — panel closes

/**
 * Super-admin Module detail — edit a module's catalog fields + author its prose
 * (draft → publish, or start a new draft from a published version) + test it out
 * (reuses the template test-chat with the module's prose as the prompt body).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Cpu, Send, MessageSquare, Zap } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { InlineError } from '@/components/ui/inline-error';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { SkillMultiSelect } from '@/components/admin/SkillMultiSelect';
import {
  useAdminModules,
  useAdminSkills,
  useEditModule,
  useEditModuleDraftVersion,
  useCreateModuleDraftVersion,
  usePublishModuleVersion,
  useTemplateTestChat,
  useModuleAgentTest,
} from '../../queries/useBotTemplatesQueries';

type ToolCall = { name: string; arguments: Record<string, unknown> };
type ChatMsg = { role: 'user' | 'assistant'; content: string; toolCalls?: ToolCall[] };

const AdminModuleDetail: React.FC = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: modules, isLoading, isError } = useAdminModules();
  const { data: skills } = useAdminSkills();
  const editModule = useEditModule();
  const editDraft = useEditModuleDraftVersion();
  const newDraft = useCreateModuleDraftVersion();
  const publish = usePublishModuleVersion();
  const testChat = useTemplateTestChat();
  const agentTest = useModuleAgentTest();

  const row = useMemo(() => modules?.find((r) => r.module.id === id), [modules, id]);
  const module = row?.module;
  const latest = useMemo(
    () => (row?.versions.length ? [...row.versions].sort((a, b) => b.version - a.version)[0] : undefined),
    [row],
  );
  const isDraft = latest?.status === 'draft';

  // Catalog form + prose draft, hydrated from the loaded module.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [prose, setProse] = useState('');
  useEffect(() => {
    if (module) {
      setName(module.name);
      setDescription(module.description ?? '');
      setSkillIds(module.skillIds);
    }
  }, [module?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setProse(latest?.prose ?? '');
  }, [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Test chat — runs against the prose currently on screen. With "Run skills" on it
  // does a DRY-RUN agent turn (bound skills' tools advertised, calls captured not run).
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [message, setMessage] = useState('');
  const [runSkills, setRunSkills] = useState(false);
  const busy = testChat.isPending || agentTest.isPending;
  const send = async () => {
    const text = message.trim();
    if (!text || busy) return;
    setMessage('');
    const history = chat.map(({ role, content }) => ({ role, content }));
    setChat((c) => [...c, { role: 'user', content: text }]);
    try {
      if (runSkills) {
        const res = await agentTest.mutateAsync({ prose, skillIds: skillIds, message: text, history });
        setChat((c) => [...c, { role: 'assistant', content: res.response ?? '', toolCalls: res.toolCalls }]);
      } else {
        const res = await testChat.mutateAsync({ body: prose, config: {}, message: text, history });
        setChat((c) => [...c, { role: 'assistant', content: res.response }]);
      }
    } catch {
      setChat((c) => [...c, { role: 'assistant', content: '(test failed — check the platform LLM key)' }]);
    }
  };

  if (isLoading) return <PageSkeleton variant="cards" />;
  if (isError) return <InlineError message="Couldn't load this module." />;
  if (!module || !latest) {
    return (
      <div className="p-6 space-y-4">
        <button onClick={() => navigate('/admin/studio?tab=modules')} className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft className="h-4 w-4" /> Back to Studio
        </button>
        <InlineError message="Module not found." />
      </div>
    );
  }

  const skillName = (sid: string) => skills?.find((s) => s.id === sid)?.displayName ?? sid;

  return (
    <div className="h-full overflow-y-auto p-6 space-y-6">
      <div className="space-y-2">
        <button onClick={() => navigate('/admin/studio?tab=modules')} className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft className="h-4 w-4" /> Back to Studio
        </button>
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold text-text-primary">{module.name}</h1>
          <div className="flex flex-wrap justify-end gap-1.5">
            {(module.skillIds.length ? module.skillIds : ['—']).map((sid) => (
              <span key={sid} className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-2 px-2 py-0.5 text-xs text-text-secondary">
                <Cpu className="h-3 w-3 text-text-muted" />
                {skillName(sid)}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Left column: authoring */}
        <div className="space-y-6">
          {/* Catalog fields */}
          <Card variant="glass">
            <CardContent className="space-y-4 p-4">
              <h2 className="text-sm font-semibold text-text-primary">Details</h2>
              <div className="space-y-1.5">
                <Label htmlFor="m-name">Name</Label>
                <Input id="m-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="m-desc">Description</Label>
                <Input id="m-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this module is for" />
              </div>
              <div className="space-y-1.5">
                <Label>Binds skills</Label>
                <SkillMultiSelect skills={skills ?? []} value={skillIds} onChange={setSkillIds} />
              </div>
              <div className="flex justify-end">
                <Button
                  disabled={editModule.isPending || !name.trim() || skillIds.length === 0}
                  onClick={() => editModule.mutate({ id: module.id, name: name.trim(), description: description.trim(), skillIds })}
                >
                  Save changes
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Prose / versions */}
          <Card variant="glass">
            <CardContent className="space-y-4 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-text-primary">Prose</h2>
                <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                  v{latest.version}
                  <Badge variant={isDraft ? 'secondary' : 'default'}>{latest.status}</Badge>
                </span>
              </div>

              {isDraft ? (
                <>
                  <Textarea
                    rows={8}
                    value={prose}
                    onChange={(e) => setProse(e.target.value)}
                    placeholder="Workflow intent + wording. Describe HOW the bot should handle this — no tool names or capability claims."
                  />
                  <p className="text-xs text-text-muted">Intent only — naming a tool (e.g. “call create_booking”) is rejected on publish.</p>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      disabled={editDraft.isPending}
                      onClick={() => editDraft.mutate({ moduleId: module.id, version: latest.version, prose, lockVersion: latest.lockVersion })}
                    >
                      Save draft
                    </Button>
                    <Button disabled={publish.isPending} onClick={() => publish.mutate({ moduleId: module.id, version: latest.version })}>
                      Publish v{latest.version}
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="whitespace-pre-wrap rounded-md border border-edge bg-surface-1 p-3 text-sm text-text-secondary">
                    {latest.prose || <span className="text-text-muted">No prose.</span>}
                  </div>
                  <p className="text-xs text-text-muted">Published versions are frozen. Start a new draft to make changes.</p>
                  <div className="flex justify-end">
                    <Button variant="outline" disabled={newDraft.isPending} onClick={() => newDraft.mutate({ moduleId: module.id, prose: latest.prose })}>
                      New draft
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: test */}
        <Card variant="glass" className="flex flex-col">
          <CardContent className="flex min-h-[28rem] flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-text-muted" />
                <h2 className="text-sm font-semibold text-text-primary">Test this module</h2>
              </div>
              <div className="flex items-center gap-2">
                <Switch id="run-skills" checked={runSkills} onCheckedChange={setRunSkills} />
                <label htmlFor="run-skills" className="cursor-pointer text-xs text-text-secondary">
                  Run skills (dry-run)
                </label>
              </div>
            </div>
            <p className="text-xs text-text-muted">
              {runSkills
                ? 'The bound skills’ tools are offered to the bot; any tool it decides to call is shown but not executed — no real bookings.'
                : 'Chat against the prose above — a quick voice check. Turn on “Run skills” to see the bound skills fire.'}
            </p>
            <div className="flex-1 space-y-2 overflow-y-auto rounded-md border border-edge bg-surface-1 p-3">
              {chat.length === 0 ? (
                <p className="pt-8 text-center text-sm text-text-muted">
                  {runSkills
                    ? 'Send a message the skills should act on (e.g. “book me a cut Thursday”).'
                    : 'Send a message to see how a bot following this prose replies.'}
                </p>
              ) : (
                chat.map((m, i) => (
                  <div key={i} className={`space-y-1 ${m.role === 'user' ? 'text-right' : 'text-left'}`}>
                    {/* Dry-run tool calls — the skills the bot decided to fire (not executed). */}
                    {m.toolCalls?.map((tc, j) => (
                      <div
                        key={j}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-[11px] text-text-secondary"
                      >
                        <Zap className="h-3 w-3 shrink-0 text-primary" />
                        <span className="truncate">
                          {tc.name}({Object.keys(tc.arguments).length ? JSON.stringify(tc.arguments) : ''})
                        </span>
                      </div>
                    ))}
                    {m.content && (
                      <div>
                        <span
                          className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-1.5 text-sm ${
                            m.role === 'user' ? 'bg-primary/20 text-text-primary' : 'bg-surface-3 text-text-secondary'
                          }`}
                        >
                          {m.content}
                        </span>
                      </div>
                    )}
                  </div>
                ))
              )}
              {busy && <p className="text-left text-sm text-text-muted">…</p>}
            </div>
            <div className="flex gap-2">
              <Input
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                placeholder="Ask something a customer might…"
              />
              <Button onClick={send} disabled={!message.trim() || busy}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AdminModuleDetail;

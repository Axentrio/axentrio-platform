/**
 * SkillsReference — the engineered skill catalog as rich, read-only cards. Each
 * card explains what the skill does, the tools it gives the bot, the plan feature
 * it needs, and when it's ready. Skills are code (a skill is a module). Shown as
 * the Skills tab in Bot Studio. Each card can bulk-apply the skill to a whole tier
 * (with a confirmation that lists exactly which templates it will touch).
 */
import { useState } from 'react';
import { Cpu, Wrench, CheckCircle2, Layers } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useAdminSkills, useApplySkillToTier, useAdminBotTemplates, type TemplateTier, type AdminSkill } from '../../queries/useBotTemplatesQueries';

const TIERS: TemplateTier[] = ['essential', 'pro', 'enterprise'];

export function SkillsReference() {
  const { data: skills } = useAdminSkills();
  const { data: templates } = useAdminBotTemplates();
  const applyMut = useApplySkillToTier();
  const [pending, setPending] = useState<{ skill: AdminSkill; tier: TemplateTier } | null>(null);

  // What a bulk-apply would actually touch — mirrors the API: active templates in
  // the tier, with a published version, that don't already bind the skill.
  const inTier = pending ? (templates ?? []).filter((t) => t.tier === pending.tier && t.status === 'active') : [];
  const willApply = pending ? inTier.filter((t) => t.latestPublishedVersion !== null && !t.skills.includes(pending.skill.id)) : [];
  const already = pending ? inTier.filter((t) => t.latestPublishedVersion !== null && t.skills.includes(pending.skill.id)) : [];
  const noPublished = pending ? inTier.filter((t) => t.latestPublishedVersion === null) : [];

  const confirm = () => {
    if (!pending) return;
    applyMut.mutate({ skillId: pending.skill.id, tier: pending.tier });
    setPending(null);
  };

  return (
    <section className="space-y-4">
      <p className="max-w-2xl text-sm text-text-secondary">
        Skills are the platform’s built-in capabilities — the tools and readiness that make an action real.
        They’re defined in code, so you can’t author them. To use one,{' '}
        <span className="text-text-primary">bind it to a template</span> (a skill is a module) — or apply it to a whole tier below.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(skills ?? []).map((s) => (
          <Card key={s.id} variant="glass">
            <CardContent className="space-y-3 p-4">
              <div className="flex items-start gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-surface-2">
                  <Cpu className="h-4 w-4 text-text-secondary" />
                </span>
                <div className="min-w-0">
                  <div className="font-medium text-text-primary">{s.displayName}</div>
                  {s.feature && (
                    <div className="text-xs text-text-muted">
                      Needs the <span className="font-mono">{s.feature}</span> plan feature
                    </div>
                  )}
                </div>
              </div>

              {s.description && <p className="text-sm text-text-secondary">{s.description}</p>}

              {s.provides.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs font-medium text-text-muted">
                    <Wrench className="h-3 w-3" /> Gives the bot
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {s.provides.map((tool) => (
                      <span key={tool} className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {s.readinessHint && (
                <div className="flex items-start gap-1.5 text-xs text-text-muted">
                  <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                  <span>{s.readinessHint}</span>
                </div>
              )}

              {/* Bulk-apply: bind this skill to every template in a tier (confirmed first). */}
              <div className="border-t border-edge/60 pt-2.5">
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                  <Layers className="h-3 w-3" /> Apply to all templates in
                </div>
                <div className="flex gap-1.5">
                  {TIERS.map((tier) => (
                    <button
                      key={tier}
                      type="button"
                      disabled={applyMut.isPending}
                      onClick={() => setPending({ skill: s, tier })}
                      className="flex-1 rounded-md border border-edge px-2 py-1 text-xs capitalize text-text-secondary transition-colors hover:border-primary-400 hover:text-text-primary disabled:opacity-50"
                    >
                      {tier}
                    </button>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {(skills ?? []).length === 0 && <p className="text-sm text-text-muted">No skills registered.</p>}
      </div>

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Apply <span className="text-primary-300">{pending?.skill.displayName}</span> to{' '}
              <span className="capitalize">{pending?.tier}</span> templates?
            </DialogTitle>
          </DialogHeader>
          {pending && (
            <div className="space-y-3 text-sm">
              {willApply.length === 0 ? (
                <p className="text-text-secondary">
                  Nothing to apply — every <span className="capitalize">{pending.tier}</span> template either already has this skill or has no published version.
                </p>
              ) : (
                <>
                  <p className="text-text-secondary">
                    This binds <span className="font-medium text-text-primary">{pending.skill.displayName}</span> to{' '}
                    <span className="font-medium text-text-primary">{willApply.length}</span> template{willApply.length === 1 ? '' : 's'}. It updates each one’s
                    current published version, so bots already on these templates get it immediately.
                  </p>
                  <ul className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-edge bg-surface-1 p-3">
                    {willApply.map((t) => (
                      <li key={t.id} className="flex items-center gap-2 text-text-primary">
                        <Cpu className="h-3.5 w-3.5 shrink-0 text-text-muted" />
                        <span className="truncate">{t.displayName}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {(already.length > 0 || noPublished.length > 0) && (
                <p className="text-xs text-text-muted">
                  {already.length > 0 && `${already.length} already have it. `}
                  {noPublished.length > 0 && `${noPublished.length} have no published version. `}
                  Skipped.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>Cancel</Button>
            <Button onClick={confirm} disabled={willApply.length === 0 || applyMut.isPending}>
              Apply to {willApply.length} template{willApply.length === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default SkillsReference;

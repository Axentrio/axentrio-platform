/**
 * SkillsReference — the engineered skill catalog as rich, read-only cards. Each
 * card explains what the skill does, the tools it gives the bot, the plan feature
 * it needs, and when it's ready. Skills are code (not authorable); a module binds
 * one or more to give them a voice. Shown as the Skills tab in Bot Studio.
 */
import { Cpu, Wrench, CheckCircle2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { useAdminSkills } from '../../queries/useBotTemplatesQueries';

export function SkillsReference() {
  const { data: skills } = useAdminSkills();
  return (
    <section className="space-y-4">
      <p className="max-w-2xl text-sm text-text-secondary">
        Skills are the platform’s built-in capabilities — the tools and readiness that make an action real.
        They’re defined in code, so you can’t author them. To use one:{' '}
        <span className="text-text-primary">bind it in a module</span>, then add that module to a template.
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
            </CardContent>
          </Card>
        ))}
        {(skills ?? []).length === 0 && <p className="text-sm text-text-muted">No skills registered.</p>}
      </div>
    </section>
  );
}

export default SkillsReference;

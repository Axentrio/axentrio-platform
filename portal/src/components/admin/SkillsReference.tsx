/**
 * SkillsReference — the engineered skill catalog, read-only. Skills are code
 * (tools + readiness); admins can't author them, a module binds one. Shown as the
 * Skills tab in Bot Studio and on the standalone Modules page.
 */
import { Cpu } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useAdminSkills } from '../../queries/useBotTemplatesQueries';

export function SkillsReference() {
  const { data: skills } = useAdminSkills();
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 text-text-muted" />
        <h2 className="text-sm font-semibold text-text-primary">Skills (engineered — read-only)</h2>
      </div>
      <p className="max-w-2xl text-sm text-text-secondary">
        Skills are platform capabilities defined in code — the tools and readiness that make an action real.
        Admins can’t author them; a module binds one to give it a voice.
      </p>
      <div className="flex flex-wrap gap-2">
        {(skills ?? []).map((s) => (
          <Badge key={s.id} variant="outline" className="gap-1.5">
            <Cpu className="h-3 w-3 text-text-muted" />
            {s.displayName}
          </Badge>
        ))}
        {(skills ?? []).length === 0 && <span className="text-sm text-text-muted">No skills registered.</span>}
      </div>
    </section>
  );
}

export default SkillsReference;

/**
 * SkillMultiSelect — pick one or more engineered skills for a module to bind. Each
 * option shows the skill name + what it does, so authors bind by capability, not id.
 */
import { Checkbox } from '@/components/ui/checkbox';
import type { AdminSkill } from '../../queries/useBotTemplatesQueries';

export function SkillMultiSelect({
  skills,
  value,
  onChange,
}: {
  skills: AdminSkill[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="space-y-1 rounded-md border border-edge bg-surface-1 p-1.5">
      {skills.length === 0 && (
        <p className="px-2 py-2 text-sm text-text-muted">No skills registered.</p>
      )}
      {skills.map((s) => {
        const checked = value.includes(s.id);
        return (
          <label
            key={s.id}
            className={`flex cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 hover:bg-surface-2 ${
              checked ? 'bg-surface-2' : ''
            }`}
          >
            <Checkbox checked={checked} onCheckedChange={() => toggle(s.id)} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-sm text-text-primary">{s.displayName}</span>
              {s.description && <span className="block text-xs text-text-muted">{s.description}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export default SkillMultiSelect;

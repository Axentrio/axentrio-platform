/**
 * Services catalog editor — list of bookable services + an add/edit dialog.
 * Replaces the single event-type editor (K3). Business availability stays a
 * separate, shared section in SchedulerSettings.
 */
import React, { useState } from 'react';
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  useServices,
  useCreateService,
  useUpdateService,
  useDeleteService,
  type Service,
  type ServiceInput,
  type IntakeQuestion,
} from '../../queries/useSchedulerQueries';

interface FormState {
  name: string;
  category: string;
  description: string;
  bookingMode: 'auto' | 'request';
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxHorizonDays: number;
  priceDisplayType: 'none' | 'fixed' | 'from' | 'range' | 'on_request';
  fixedPrice: string;
  minPrice: string;
  maxPrice: string;
  priceNote: string;
  locationType: string;
  isActive: boolean;
  intakeQuestions: IntakeQuestion[];
}

const BLANK: FormState = {
  name: '',
  category: '',
  description: '',
  bookingMode: 'auto',
  durationMin: 30,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  minNoticeMin: 60,
  maxHorizonDays: 60,
  priceDisplayType: 'none',
  fixedPrice: '',
  minPrice: '',
  maxPrice: '',
  priceNote: '',
  locationType: 'custom',
  isActive: true,
  intakeQuestions: [],
};

function formFromService(s: Service): FormState {
  return {
    name: s.name,
    category: s.category ?? '',
    description: s.description ?? '',
    bookingMode: s.bookingMode,
    durationMin: s.durationMin,
    bufferBeforeMin: s.bufferBeforeMin,
    bufferAfterMin: s.bufferAfterMin,
    minNoticeMin: s.minNoticeMin,
    maxHorizonDays: s.maxHorizonDays,
    priceDisplayType: s.priceDisplayType,
    fixedPrice: s.fixedPrice != null ? String(s.fixedPrice) : '',
    minPrice: s.minPrice != null ? String(s.minPrice) : '',
    maxPrice: s.maxPrice != null ? String(s.maxPrice) : '',
    priceNote: s.priceNote ?? '',
    locationType: s.locationType,
    isActive: s.isActive,
    // Preserve each question's server id so saves don't re-mint + orphan answer labels.
    intakeQuestions: Array.isArray(s.intakeQuestions)
      ? s.intakeQuestions.map((q) => ({ ...q, options: q.options ? [...q.options] : undefined }))
      : [],
  };
}

function toInput(f: FormState): ServiceInput {
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  return {
    name: f.name.trim(),
    category: f.category.trim() || undefined,
    description: f.description.trim() || undefined,
    bookingMode: f.bookingMode,
    durationMin: f.durationMin,
    bufferBeforeMin: f.bufferBeforeMin,
    bufferAfterMin: f.bufferAfterMin,
    minNoticeMin: f.minNoticeMin,
    maxHorizonDays: f.maxHorizonDays,
    priceDisplayType: f.priceDisplayType,
    fixedPrice: f.priceDisplayType === 'fixed' || f.priceDisplayType === 'from' ? num(f.fixedPrice) : undefined,
    minPrice: f.priceDisplayType === 'range' ? num(f.minPrice) : undefined,
    maxPrice: f.priceDisplayType === 'range' ? num(f.maxPrice) : undefined,
    priceNote: f.priceNote.trim() || undefined,
    locationType: f.locationType,
    isActive: f.isActive,
    // Always send the array (even []) so the server replaces/clears; echo each id.
    intakeQuestions: f.intakeQuestions.map((q) => ({
      ...(q.id ? { id: q.id } : {}),
      label: q.label.trim(),
      type: q.type,
      required: q.required,
      ...(q.type === 'choice'
        ? { options: (q.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0) }
        : {}),
    })),
  };
}

/** Client-side mirror of the server rules (server stays authoritative). */
function questionsError(questions: IntakeQuestion[]): string | null {
  if (questions.length > 8) return 'At most 8 questions per service.';
  for (const q of questions) {
    if (!q.label.trim()) return 'Every question needs a label.';
    if (q.type === 'choice') {
      const opts = (q.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0);
      if (opts.length < 2) return `"${q.label.trim() || 'Choice question'}" needs at least 2 options.`;
      if (opts.length > 10) return `"${q.label.trim()}" can have at most 10 options.`;
      const seen = new Set(opts.map((o) => o.toLowerCase()));
      if (seen.size !== opts.length) return `"${q.label.trim()}" has duplicate options.`;
    }
  }
  return null;
}

function priceLabel(s: Service): string {
  switch (s.priceDisplayType) {
    case 'fixed':
      return s.fixedPrice != null ? `€${s.fixedPrice}` : '';
    case 'from':
      return s.fixedPrice != null ? `from €${s.fixedPrice}` : '';
    case 'range':
      return s.minPrice != null && s.maxPrice != null ? `€${s.minPrice}–€${s.maxPrice}` : '';
    case 'on_request':
      return 'on request';
    default:
      return '';
  }
}

export const ServicesSection: React.FC = () => {
  const { data, isLoading } = useServices();
  const create = useCreateService();
  const update = useUpdateService();
  const remove = useDeleteService();

  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(BLANK);

  const services = data?.services ?? [];
  const saving = create.isPending || update.isPending;

  const openNew = () => {
    setForm(BLANK);
    setEditing('new');
  };
  const openEdit = (s: Service) => {
    setForm(formFromService(s));
    setEditing(s);
  };
  const close = () => setEditing(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((p) => ({ ...p, [k]: v }));

  const qError = questionsError(form.intakeQuestions);

  const save = () => {
    if (!form.name.trim() || !(form.durationMin >= 5) || qError) return;
    const input = toInput(form);
    if (editing === 'new') {
      create.mutate(input, { onSuccess: close });
    } else if (editing) {
      update.mutate({ id: editing.id, input }, { onSuccess: close });
    }
  };

  return (
    <div className="space-y-3 border-t border-edge pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-text-primary">Services</h3>
        <Button variant="outline" size="sm" type="button" onClick={openNew}>
          <Plus className="w-3.5 h-3.5" /> Add service
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : services.length === 0 ? (
        <p className="text-xs text-text-muted">
          No services yet. Add the services customers can book (e.g. “Men’s haircut”, “Consultation”).
        </p>
      ) : (
        <div className="divide-y divide-edge rounded-lg border border-edge">
          {services.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-sm font-medium ${s.isActive ? 'text-text-primary' : 'text-text-muted line-through'}`}>
                    {s.name}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      s.bookingMode === 'request' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'
                    }`}
                  >
                    {s.bookingMode === 'request' ? 'request-only' : 'auto-book'}
                  </span>
                  {!s.isActive && <span className="text-[11px] text-text-muted">(inactive)</span>}
                </div>
                <div className="mt-0.5 text-xs text-text-secondary">
                  {s.durationMin} min{priceLabel(s) ? ` · ${priceLabel(s)}` : ''}
                  {s.category ? ` · ${s.category}` : ''}
                </div>
              </div>
              <Button variant="ghost" size="sm" type="button" onClick={() => openEdit(s)}>
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              {s.isActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  className="text-red-400 hover:text-red-300"
                  onClick={() => remove.mutate(s.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing === 'new' ? 'Add service' : 'Edit service'}</DialogTitle>
            <DialogDescription>Configure how the assistant books this service.</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label className="text-text-secondary mb-1 block">Name</Label>
              <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Men’s haircut" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-text-secondary mb-1 block">Category</Label>
                <Input value={form.category} onChange={(e) => set('category', e.target.value)} placeholder="Optional" />
              </div>
              <div>
                <Label className="text-text-secondary mb-1 block">Booking mode</Label>
                <select
                  value={form.bookingMode}
                  onChange={(e) => set('bookingMode', e.target.value as FormState['bookingMode'])}
                  className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary text-sm"
                >
                  <option value="auto">Auto-book (confirm automatically)</option>
                  <option value="request">Request-only (capture as a request)</option>
                </select>
              </div>
            </div>

            <div>
              <Label className="text-text-secondary mb-1 block">Description</Label>
              <Input
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="Optional short description"
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <NumberField label="Duration (min)" value={form.durationMin} onChange={(v) => set('durationMin', v)} min={5} />
              <NumberField label="Buffer before" value={form.bufferBeforeMin} onChange={(v) => set('bufferBeforeMin', v)} min={0} />
              <NumberField label="Buffer after" value={form.bufferAfterMin} onChange={(v) => set('bufferAfterMin', v)} min={0} />
              <NumberField label="Min notice (min)" value={form.minNoticeMin} onChange={(v) => set('minNoticeMin', v)} min={0} />
              <NumberField label="Max horizon (days)" value={form.maxHorizonDays} onChange={(v) => set('maxHorizonDays', v)} min={1} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-text-secondary mb-1 block">Price display</Label>
                <select
                  value={form.priceDisplayType}
                  onChange={(e) => set('priceDisplayType', e.target.value as FormState['priceDisplayType'])}
                  className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary text-sm"
                >
                  <option value="none">No price</option>
                  <option value="fixed">Fixed</option>
                  <option value="from">Starting from</option>
                  <option value="range">Range</option>
                  <option value="on_request">On request</option>
                </select>
              </div>
              {(form.priceDisplayType === 'fixed' || form.priceDisplayType === 'from') && (
                <NumberField label="Price (€)" value={Number(form.fixedPrice) || 0} onChange={(v) => set('fixedPrice', String(v))} min={0} />
              )}
              {form.priceDisplayType === 'range' && (
                <div className="grid grid-cols-2 gap-2">
                  <NumberField label="Min (€)" value={Number(form.minPrice) || 0} onChange={(v) => set('minPrice', String(v))} min={0} />
                  <NumberField label="Max (€)" value={Number(form.maxPrice) || 0} onChange={(v) => set('maxPrice', String(v))} min={0} />
                </div>
              )}
            </div>

            <QuestionsEditor
              questions={form.intakeQuestions}
              onChange={(qs) => set('intakeQuestions', qs)}
              error={qError}
            />

            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox checked={form.isActive} onCheckedChange={(c) => set('isActive', c === true)} />
              <span className="text-sm text-text-secondary">Active (offered to customers)</span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving || !form.name.trim() || !!qError}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {editing === 'new' ? 'Add service' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

const NumberField: React.FC<{ label: string; value: number; onChange: (v: number) => void; min?: number }> = ({
  label,
  value,
  onChange,
  min,
}) => (
  <div>
    <Label className="text-text-secondary mb-1 block">{label}</Label>
    <Input
      type="number"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      onChange={(e) => onChange(parseInt(e.target.value, 10))}
    />
  </div>
);

/**
 * Repeatable intake-questions editor. Rows keep their server `id` (carried so a
 * save doesn't re-mint ids and orphan historical answer labels). `choice`
 * questions edit options as individual add/remove rows.
 */
const QuestionsEditor: React.FC<{
  questions: IntakeQuestion[];
  onChange: (qs: IntakeQuestion[]) => void;
  error: string | null;
}> = ({ questions, onChange, error }) => {
  const update = (i: number, patch: Partial<IntakeQuestion>) =>
    onChange(questions.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  const remove = (i: number) => onChange(questions.filter((_, idx) => idx !== i));
  const add = () => onChange([...questions, { label: '', type: 'text', required: false }]);

  return (
    <div className="space-y-2 border-t border-edge pt-3">
      <div className="flex items-center justify-between">
        <Label className="text-text-secondary">Intake questions</Label>
        <Button variant="outline" size="sm" type="button" onClick={add} disabled={questions.length >= 8}>
          <Plus className="w-3.5 h-3.5" /> Add question
        </Button>
      </div>
      <p className="text-xs text-text-muted">
        The assistant asks these before booking and saves the answers on the booking. Up to 8.
      </p>

      {questions.map((q, i) => (
        <div key={i} className="rounded-lg border border-edge p-2.5 space-y-2">
          <div className="flex items-start gap-2">
            <Input
              value={q.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Question (e.g. What's the occasion?)"
            />
            <select
              value={q.type}
              onChange={(e) => {
                const type = e.target.value as IntakeQuestion['type'];
                update(i, { type, options: type === 'choice' ? q.options ?? ['', ''] : undefined });
              }}
              className="px-2 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary text-sm"
            >
              <option value="text">Text</option>
              <option value="choice">Choice</option>
            </select>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="text-red-400 hover:text-red-300 shrink-0"
              onClick={() => remove(i)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={q.required} onCheckedChange={(c) => update(i, { required: c === true })} />
            <span className="text-xs text-text-secondary">Required</span>
          </label>

          {q.type === 'choice' && (
            <div className="space-y-1.5 pl-1">
              {(q.options ?? []).map((opt, oi) => (
                <div key={oi} className="flex items-center gap-2">
                  <Input
                    value={opt}
                    onChange={(e) =>
                      update(i, { options: (q.options ?? []).map((o, idx) => (idx === oi ? e.target.value : o)) })
                    }
                    placeholder={`Option ${oi + 1}`}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    className="text-red-400 hover:text-red-300 shrink-0"
                    onClick={() => update(i, { options: (q.options ?? []).filter((_, idx) => idx !== oi) })}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => update(i, { options: [...(q.options ?? []), ''] })}
                disabled={(q.options ?? []).length >= 10}
              >
                <Plus className="w-3.5 h-3.5" /> Add option
              </Button>
            </div>
          )}
        </div>
      ))}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
};

export default ServicesSection;

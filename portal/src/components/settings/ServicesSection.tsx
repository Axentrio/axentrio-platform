/**
 * Services catalog editor — list of bookable services + an add/edit dialog.
 * Replaces the single event-type editor (K3). Business availability stays a
 * separate, shared section in SchedulerSettings.
 */
import React, { useState } from 'react';
import { Plus, Pencil, Trash2, Loader2, Sparkles, ChevronUp, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  useServices,
  useCreateService,
  useUpdateService,
  useDeleteService,
  useReorderServices,
  usePresets,
  useApplyPreset,
  type Service,
  type ServiceInput,
  type IntakeQuestion,
} from '../../queries/useSchedulerQueries';

interface FormState {
  name: string;
  category: string;
  description: string;
  preparationInstructions: string;
  bookingMode: 'auto' | 'request';
  durationMode: 'fixed' | 'range' | 'ai';
  durationMin: number;
  minDurationMin: string;
  maxDurationMin: string;
  // Strings, like the other optional numerics in this form: '' means INHERIT.
  bufferBeforeMin: string;
  bufferAfterMin: string;
  minNoticeMin: string;
  maxHorizonDays: string;
  priceDisplayType: 'none' | 'fixed' | 'from' | 'range' | 'on_request';
  fixedPrice: string;
  minPrice: string;
  maxPrice: string;
  priceNote: string;
  locationType: string;
  isActive: boolean;
  onlineBookable: boolean;
  customerAddressRequired: boolean;
  customerLocationRequired: boolean;
  fileUploadAllowed: boolean;
  maxBookingsPerDay: string;
  intakeQuestions: IntakeQuestion[];
}

const BLANK: FormState = {
  name: '',
  category: '',
  description: '',
  preparationInstructions: '',
  bookingMode: 'auto',
  durationMode: 'fixed',
  durationMin: 30,
  minDurationMin: '',
  maxDurationMin: '',
  // Blank by default so a new service inherits the business settings rather than
  // silently restating them — restating is what made them impossible to change in one place.
  bufferBeforeMin: '',
  bufferAfterMin: '',
  minNoticeMin: '',
  maxHorizonDays: '',
  priceDisplayType: 'none',
  fixedPrice: '',
  minPrice: '',
  maxPrice: '',
  priceNote: '',
  locationType: 'custom',
  isActive: true,
  onlineBookable: true,
  customerAddressRequired: false,
  customerLocationRequired: false,
  fileUploadAllowed: false,
  maxBookingsPerDay: '',
  intakeQuestions: [],
};

function formFromService(s: Service): FormState {
  return {
    name: s.name,
    category: s.category ?? '',
    description: s.description ?? '',
    preparationInstructions: s.preparationInstructions ?? '',
    bookingMode: s.bookingMode,
    durationMode: s.durationMode ?? 'fixed',
    durationMin: s.durationMin,
    // Defensive: a range/ai row with null bounds pre-fills from durationMin so the
    // form never renders blank/NaN and the owner must enter valid bounds before saving.
    minDurationMin: s.minDurationMin != null ? String(s.minDurationMin) : (s.durationMode !== 'fixed' ? String(s.durationMin) : ''),
    maxDurationMin: s.maxDurationMin != null ? String(s.maxDurationMin) : (s.durationMode !== 'fixed' ? String(s.durationMin) : ''),
    bufferBeforeMin: s.bufferBeforeMin != null ? String(s.bufferBeforeMin) : '',
    bufferAfterMin: s.bufferAfterMin != null ? String(s.bufferAfterMin) : '',
    minNoticeMin: s.minNoticeMin != null ? String(s.minNoticeMin) : '',
    maxHorizonDays: s.maxHorizonDays != null ? String(s.maxHorizonDays) : '',
    priceDisplayType: s.priceDisplayType,
    fixedPrice: s.fixedPrice != null ? String(s.fixedPrice) : '',
    minPrice: s.minPrice != null ? String(s.minPrice) : '',
    maxPrice: s.maxPrice != null ? String(s.maxPrice) : '',
    priceNote: s.priceNote ?? '',
    locationType: s.locationType,
    isActive: s.isActive,
    onlineBookable: s.onlineBookable !== false,
    customerAddressRequired: !!s.customerAddressRequired,
    customerLocationRequired: !!s.customerLocationRequired,
    fileUploadAllowed: !!s.fileUploadAllowed,
    maxBookingsPerDay: s.maxBookingsPerDay != null ? String(s.maxBookingsPerDay) : '',
    // Preserve each question's server id so saves don't re-mint + orphan answer labels.
    intakeQuestions: Array.isArray(s.intakeQuestions)
      ? s.intakeQuestions.map((q) => ({ ...q, options: q.options ? [...q.options] : undefined }))
      : [],
  };
}

function toInput(f: FormState): ServiceInput {
  /**
   * Blank means CLEAR — send null, never undefined.
   *
   * `undefined` does not survive JSON.stringify, so the key never reaches the server, the
   * controller's `Object.assign` leaves the stored value untouched, and the owner's old
   * description, price note or prep instructions keep reaching the prompt, the invite and
   * the customer. No error is raised anywhere; the field simply refuses to empty.
   */
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v));
  const text = (v: string): string | null => (v.trim() === '' ? null : v.trim());
  // Same contract, kept under its original name for the timing fields it was written for.
  const inherit = num;
  return {
    name: f.name.trim(),
    category: text(f.category),
    description: text(f.description),
    preparationInstructions: text(f.preparationInstructions),
    bookingMode: f.bookingMode,
    durationMode: f.durationMode,
    durationMin: f.durationMin,
    minDurationMin: f.durationMode === 'fixed' ? null : num(f.minDurationMin),
    maxDurationMin: f.durationMode === 'fixed' ? null : num(f.maxDurationMin),
    bufferBeforeMin: inherit(f.bufferBeforeMin),
    bufferAfterMin: inherit(f.bufferAfterMin),
    minNoticeMin: inherit(f.minNoticeMin),
    maxHorizonDays: inherit(f.maxHorizonDays),
    priceDisplayType: f.priceDisplayType,
    fixedPrice: f.priceDisplayType === 'fixed' || f.priceDisplayType === 'from' ? num(f.fixedPrice) : null,
    minPrice: f.priceDisplayType === 'range' ? num(f.minPrice) : null,
    maxPrice: f.priceDisplayType === 'range' ? num(f.maxPrice) : null,
    priceNote: text(f.priceNote),
    locationType: f.locationType,
    isActive: f.isActive,
    onlineBookable: f.onlineBookable,
    customerAddressRequired: f.customerAddressRequired,
    customerLocationRequired: f.customerLocationRequired,
    fileUploadAllowed: f.fileUploadAllowed,
    maxBookingsPerDay: num(f.maxBookingsPerDay),
    // Always send the array (even []) so the server replaces/clears; echo each id.
    intakeQuestions: f.intakeQuestions.map((q) => ({
      ...(q.id ? { id: q.id } : {}),
      label: q.label.trim(),
      type: q.type,
      required: q.required,
      ...(q.type === 'choice'
        ? { options: (q.options ?? []).flatMap((o) => { const t = o.trim(); return t.length > 0 ? [t] : []; }) }
        : {}),
      // Rebuilt field by field, exactly like the server reconciler — which means a field
      // added to the editor but forgotten HERE is silently dropped on every save, with no
      // error anywhere. Only the non-default values are sent: absent means "ask it" and
      // "show it", so writing those adds noise for no change in meaning.
      ...(q.aiInstruction?.trim() ? { aiInstruction: q.aiInstruction.trim() } : {}),
      ...(q.exampleAnswer?.trim() ? { exampleAnswer: q.exampleAnswer.trim() } : {}),
      ...(q.active === false ? { active: false } : {}),
      ...(q.includeInCalendar === false ? { includeInCalendar: false } : {}),
    })),
  };
}

/** Client-side mirror of the server rules (server stays authoritative). */
function questionsError(questions: IntakeQuestion[]): string | null {
  if (questions.length > 8) return 'At most 8 questions per service.';
  for (const q of questions) {
    if (!q.label.trim()) return 'Every question needs a label.';
    if (q.type === 'choice') {
      const opts = (q.options ?? []).flatMap((o) => { const t = o.trim(); return t.length > 0 ? [t] : []; });
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

/** `onApplied` lets the parent (SchedulerSettings) re-hydrate seeded availability after a preset. */
export const ServicesSection: React.FC<{ onApplied?: () => void; botId?: string }> = ({
  onApplied,
  /**
   * Which Agent's catalogue this is (#86). `undefined` is a real value meaning the tenant's
   * default — see `botScope` — and is what the editor holds on first render.
   *
   * PASS IT ANYWAY when you have one. This prop was missing for a whole commit, and the result
   * was the failure the ticket calls worse than fixing nothing: an owner picks Agent B, sees
   * B's settings, adds a service, and the service lands on Agent A.
   */
  botId,
}) => {
  const { data, isLoading, isSuccess } = useServices(true /* enabled */, botId);
  const create = useCreateService(botId);
  const update = useUpdateService(botId);
  const remove = useDeleteService(botId);
  const reorder = useReorderServices(botId);
  /**
   * Move a service one place. Sends the WHOLE resulting order, because the server assigns
   * positions from the array — the client never invents sortOrder numbers, so what is
   * stored cannot disagree with what the owner just saw.
   */
  const moveService = (index: number, delta: number) => {
    const next = [...services];
    const j = index + delta;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    reorder.mutate(next.map((x) => x.id));
  };

  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(BLANK);
  const [pendingDelete, setPendingDelete] = useState<Service | null>(null);
  const [showPresets, setShowPresets] = useState(false);

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

  // P5c: a range/ai duration needs valid 5 ≤ min ≤ max before save.
  const durationError =
    form.durationMode !== 'fixed' &&
    (() => {
      const lo = Number(form.minDurationMin);
      const hi = Number(form.maxDurationMin);
      return !(lo >= 5 && hi >= 5 && lo <= hi);
    })();

  const save = () => {
    if (!form.name.trim() || !(form.durationMin >= 5) || qError || durationError) return;
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
        <div className="space-y-2">
          <p className="text-xs text-text-muted">
            No services yet. Add the services customers can book (e.g. “Men’s haircut”, “Consultation”), or start
            from a preset.
          </p>
          {isSuccess && (
            <Button variant="outline" size="sm" type="button" onClick={() => setShowPresets(true)}>
              <Sparkles className="w-3.5 h-3.5" /> Start from a preset
            </Button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-edge rounded-lg border border-edge">
          {services.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-sm font-medium ${s.isActive ? 'text-text-primary' : 'text-text-muted line-through'}`}>
                    {s.name}
                  </span>
                  {/*
                    "auto-book" is untrue for a service the assistant will never book, so the
                    badge is suppressed rather than contradicting the row beside it.
                  */}
                  {s.onlineBookable !== false && (
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        s.bookingMode === 'request' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'
                      }`}
                    >
                      {s.bookingMode === 'request' ? 'request-only' : 'auto-book'}
                    </span>
                  )}
                  {!s.isActive && <span className="text-[11px] text-text-muted">(inactive)</span>}
                  {/*
                    Gated on isActive so an inactive service does not stack two muted markers.
                    Without this the switch had no visible effect at all: an owner unticks
                    "customers can book this online", saves, and the row looks identical.
                  */}
                  {s.isActive && s.onlineBookable === false && (
                    <span className="text-[11px] text-text-muted">(not bookable online)</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-text-secondary">
                  {s.durationMin} min{priceLabel(s) ? ` · ${priceLabel(s)}` : ''}
                  {s.category ? ` · ${s.category}` : ''}
                </div>
              </div>
              {/*
                Order is what the assistant reads out, so the owner needs to control it.
                Up/down rather than drag: this list is short, and a keyboard-reachable
                button works for everyone.
              */}
              <div className="flex items-center gap-0.5 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-label={`Move ${s.name} up`}
                  disabled={reorder.isPending || services.indexOf(s) === 0}
                  onClick={() => moveService(services.indexOf(s), -1)}
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  aria-label={`Move ${s.name} down`}
                  disabled={reorder.isPending || services.indexOf(s) === services.length - 1}
                  onClick={() => moveService(services.indexOf(s), 1)}
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </Button>
              </div>
              <Switch
                checked={s.isActive}
                disabled={update.isPending}
                onCheckedChange={(c) => update.mutate({ id: s.id, input: { isActive: c } })}
                aria-label={s.isActive ? `Disable ${s.name}` : `Enable ${s.name}`}
                title={s.isActive ? 'Disable (hide from customers)' : 'Enable (offer to customers)'}
              />
              {/* Icon-only, so they need a name — the toggle beside them already has one. */}
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-label={`Edit ${s.name}`}
                title="Edit"
                onClick={() => openEdit(s)}
              >
                <Pencil className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-label={`Delete ${s.name}`}
                title="Delete"
                className="text-red-400 hover:text-red-300"
                onClick={() => setPendingDelete(s)}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <ServiceEditorDialog
        editing={editing}
        form={form}
        set={set}
        save={save}
        close={close}
        saving={saving}
        qError={qError}
        durationError={durationError}
      />

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete service?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" will be permanently deleted. Existing bookings are kept but lose their link to this service. To hide it from customers without deleting, use the toggle instead. This can't be undone.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (pendingDelete) remove.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PresetDialog
        open={showPresets}
        onClose={() => setShowPresets(false)}
        onApplied={onApplied}
        botId={botId}
      />
    </div>
  );
};

/** The add/edit service form, lifted out of ServicesSection (no-giant-component).
 *  Verbatim JSX — form state stays in ServicesSection, passed as props. */
const ServiceEditorDialog: React.FC<{
  editing: Service | 'new' | null;
  form: FormState;
  set: <K extends keyof FormState>(k: K, v: FormState[K]) => void;
  save: () => void;
  close: () => void;
  saving: boolean;
  qError: ReturnType<typeof questionsError>;
  durationError: boolean;
}> = ({ editing, form, set, save, close, saving, qError, durationError }) => {
  return (
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
                <Select
                  value={form.bookingMode}
                  onValueChange={(v) => set('bookingMode', v as FormState['bookingMode'])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto-book (confirm automatically)</SelectItem>
                    <SelectItem value="request">Request-only (capture as a request)</SelectItem>
                  </SelectContent>
                </Select>
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

            {/* Stored since P5 with no editor anywhere and read by nothing — so no owner
                could set it and no customer could ever receive it. Now on the invite. */}
            <div>
              <Label className="text-text-secondary mb-1 block">Preparation instructions</Label>
              <Input
                value={form.preparationInstructions}
                onChange={(e) => set('preparationInstructions', e.target.value)}
                placeholder="e.g. Please arrive with clean, dry hair"
              />
              <p className="mt-1 text-xs text-text-muted">
                Sent to the customer in their confirmation email and shown on your calendar entry.
              </p>
            </div>

            <div>
              <Label htmlFor="svc-duration-mode" className="text-text-secondary mb-1 block">Duration</Label>
              <select
                id="svc-duration-mode"
                value={form.durationMode}
                onChange={(e) => set('durationMode', e.target.value as FormState['durationMode'])}
                className="w-full px-3 py-2 bg-surface-3 border border-edge rounded-xl text-text-primary text-sm"
              >
                <option value="fixed">Fixed length</option>
                <option value="range">Customer chooses a length (range)</option>
                <option value="ai">AI estimates the length (within a range)</option>
              </select>
            </div>

            <div className="grid grid-cols-3 gap-3">
              {form.durationMode === 'fixed' ? (
                <NumberField label="Duration (min)" value={form.durationMin} onChange={(v) => set('durationMin', v)} min={5} />
              ) : (
                <>
                  <div>
                    <Label className="text-text-secondary mb-1 block">Min (min)</Label>
                    <Input type="number" min={5} value={form.minDurationMin} onChange={(e) => set('minDurationMin', e.target.value)} />
                  </div>
                  <div>
                    <Label className="text-text-secondary mb-1 block">Max (min)</Label>
                    <Input type="number" min={5} value={form.maxDurationMin} onChange={(e) => set('maxDurationMin', e.target.value)} />
                  </div>
                </>
              )}
              <InheritableNumberField label="Buffer before" value={form.bufferBeforeMin} onChange={(v) => set('bufferBeforeMin', v)} min={0} />
              <InheritableNumberField label="Buffer after" value={form.bufferAfterMin} onChange={(v) => set('bufferAfterMin', v)} min={0} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <InheritableNumberField label="Min notice (min)" value={form.minNoticeMin} onChange={(v) => set('minNoticeMin', v)} min={0} />
              <InheritableNumberField label="Max horizon (days)" value={form.maxHorizonDays} onChange={(v) => set('maxHorizonDays', v)} min={1} />
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-text-secondary mb-1 block">Price display</Label>
                  <Select
                    value={form.priceDisplayType}
                    onValueChange={(v) => set('priceDisplayType', v as FormState['priceDisplayType'])}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No price</SelectItem>
                      <SelectItem value="fixed">Fixed</SelectItem>
                      <SelectItem value="from">Starting from</SelectItem>
                      <SelectItem value="range">Range</SelectItem>
                      <SelectItem value="on_request">On request</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(form.priceDisplayType === 'fixed' || form.priceDisplayType === 'from') && (
                  <NumberField label="Price (€)" value={Number(form.fixedPrice) || 0} onChange={(v) => set('fixedPrice', String(v))} min={0} />
                )}
              </div>
              {form.priceDisplayType === 'range' && (
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label="Min (€)" value={Number(form.minPrice) || 0} onChange={(v) => set('minPrice', String(v))} min={0} />
                  <NumberField label="Max (€)" value={Number(form.maxPrice) || 0} onChange={(v) => set('maxPrice', String(v))} min={0} />
                </div>
              )}
            </div>

            {form.priceDisplayType !== 'none' && (
              <div>
                <Label className="text-text-secondary mb-1 block">Price note (optional)</Label>
                <Input
                  value={form.priceNote}
                  onChange={(e) => set('priceNote', e.target.value)}
                  placeholder="e.g. per hour, excl. materials"
                />
              </div>
            )}

            <QuestionsEditor
              questions={form.intakeQuestions}
              onChange={(qs) => set('intakeQuestions', qs)}
              error={qError}
            />

            <div className="space-y-2 border-t border-edge pt-3">
              {/*
                Where this service happens. Stored since the beginning and read by the
                booking engine, the invite and the calendar mirror — but with no control
                here every hand-created service was stuck on 'custom', so an online
                consultation never got a meeting link and an at-premises job never showed
                the business address on the invite.
              */}
              <div className="space-y-1.5 pb-1">
                <Label htmlFor="svc-location-type">Where does it happen?</Label>
                <select
                  id="svc-location-type"
                  className="w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-text-primary"
                  value={form.locationType}
                  onChange={(e) => set('locationType', e.target.value)}
                >
                  {/* `unset` is not offered. It is the state a Service created before this
                      control existed arrives in (#71), so it must be SELECTABLE to leave and
                      never selectable to enter - otherwise saving the form would silently move
                      a settled Service back into "never asked". */}
                  {form.locationType === 'unset' && (
                    <option value="unset">Not set yet — please choose</option>
                  )}
                  <option value="in_person">In person</option>
                  <option value="google_meet">Video call (a meeting link is created)</option>
                  <option value="phone">Phone call</option>
                  <option value="custom">Something else</option>
                </select>
                <p className="text-xs text-text-muted">
                  {form.locationType === 'unset'
                    ? 'This service was created before this setting existed, so nobody has chosen. Your address is going on the invite for now — pick the right answer to settle it.'
                    : form.locationType === 'google_meet'
                      ? 'A video link is generated and sent with the invite.'
                      : form.locationType === 'in_person'
                        ? form.customerAddressRequired
                          ? 'You travel to the customer — their address goes on the invite.'
                          : 'The customer comes to you — your address goes on the invite, once you have set one under Availability.'
                        : 'No location is put on the invite.'}
                </p>
              </div>
              <label htmlFor="svc-addr-req" className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  id="svc-addr-req"
                  checked={form.customerAddressRequired}
                  onCheckedChange={(c) => set('customerAddressRequired', c === true)}
                />
                <span className="text-sm text-text-secondary">Requires customer address</span>
              </label>
              <label htmlFor="svc-phone-req" className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  id="svc-phone-req"
                  checked={form.customerLocationRequired}
                  onCheckedChange={(c) => set('customerLocationRequired', c === true)}
                />
                <span className="text-sm text-text-secondary">Requires customer phone (mobile / on-site job)</span>
              </label>
              {/*
                Without this the portal could only ever create bookable services: the field
                was never in the form, so the API's `default(true)` always won. An owner who
                wanted a service listed but not self-bookable had no way to say so.
              */}
              <label htmlFor="svc-online-bookable" className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  id="svc-online-bookable"
                  checked={form.onlineBookable}
                  onCheckedChange={(c) => set('onlineBookable', c === true)}
                />
                <span className="text-sm text-text-secondary">
                  Customers can book this online
                  <span className="block text-xs text-text-muted">
                    Off: the assistant will not offer it or take a booking for it. Use this for a
                    service you quote by phone first.
                  </span>
                </span>
              </label>
              <label htmlFor="svc-file-allowed" className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  id="svc-file-allowed"
                  checked={form.fileUploadAllowed}
                  onCheckedChange={(c) => set('fileUploadAllowed', c === true)}
                />
                <span className="text-sm text-text-secondary">Allow file upload (e.g. a photo of the job)</span>
              </label>
              <div>
                <Label htmlFor="svc-max-per-day" className="text-text-secondary mb-1 block">Max bookings per day</Label>
                <Input
                  id="svc-max-per-day"
                  type="number"
                  min={1}
                  value={form.maxBookingsPerDay}
                  onChange={(e) => set('maxBookingsPerDay', e.target.value)}
                  placeholder="Unlimited"
                />
              </div>
            </div>

            <label htmlFor="service-active" className="flex items-center gap-2 cursor-pointer">
              <Checkbox id="service-active" checked={form.isActive} onCheckedChange={(c) => set('isActive', c === true)} />
              <span className="text-sm text-text-secondary">Active (offered to customers)</span>
            </label>
          </div>

          {durationError && (
            <p className="text-xs text-red-400">Enter a valid duration range (5 ≤ min ≤ max).</p>
          )}
          <DialogFooter>
            <Button variant="outline" type="button" onClick={close}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving || !form.name.trim() || !!qError || durationError}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {editing === 'new' ? 'Add service' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  );
};

/**
 * Preset picker — lists presets and applies the chosen one (empty-catalog seeding).
 *
 * Takes the Agent for the same reason everything else here does: applying a preset writes a
 * whole service catalogue, so an unscoped one lands every service on the anchor.
 */
const PresetDialog: React.FC<{
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
  botId?: string;
}> = ({
  open,
  onClose,
  onApplied,
  botId,
}) => {
  const { data, isLoading, isError } = usePresets(open);
  const apply = useApplyPreset(botId);
  const presets = data?.presets ?? [];

  const onApply = (key: string) =>
    apply.mutate(key, {
      onSuccess: () => {
        onApplied?.();
        onClose();
      },
    });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !apply.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Start from a preset</DialogTitle>
          <DialogDescription>
            Pick your business type to add a starter set of services (and default hours). Prices and hours are
            starting points you can edit afterwards.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-text-muted">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : isError ? (
          <p className="p-4 text-sm text-red-400">Couldn’t load presets. Close and try again.</p>
        ) : (
          <div className="divide-y divide-edge rounded-lg border border-edge">
            {presets.map((p) => (
              <div key={p.key} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text-primary">{p.label}</div>
                  <div className="mt-0.5 text-xs text-text-secondary">
                    {p.description} · {p.serviceCount} services
                  </div>
                </div>
                <Button size="sm" type="button" disabled={apply.isPending} onClick={() => onApply(p.key)}>
                  {apply.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Apply'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

/** '' → inherit. Empty is a real, savable state here, so no NaN and no snap-back to 0. */
const InheritableNumberField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
}> = ({ label, value, onChange, min }) => (
  <div>
    <Label className="text-text-secondary mb-1 block">{label}</Label>
    <Input type="number" value={value} min={min} placeholder="Inherited" onChange={(e) => onChange(e.target.value)} />
  </div>
);

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
  /**
   * Which STORED question is pending removal.
   *
   * Deleting a question does not delete its answers — those live on each booking row — but it
   * does delete the LABEL they are displayed under, so every historical answer falls back to
   * showing a raw uuid. That is irreversible from the portal and invisible until someone
   * opens an old booking, which is exactly the kind of thing worth one confirmation.
   *
   * Only STORED questions confirm. A row with no server `id` was added in this dialog and
   * never saved, so it provably has no answers and must delete instantly.
   */
  const [pendingRemove, setPendingRemove] = useState<number | null>(null);
  /**
   * Reorder by MOVING the array element, not by storing a sort index.
   *
   * Array position already IS the order everywhere downstream — the prompt renders in array
   * order and the reconciler preserves it. A `sortOrder` field would be a second source of
   * truth for the same fact, and the two would drift the first time anyone edited one
   * without the other.
   */
  const move = (i: number, delta: number) => {
    const j = i + delta;
    if (j < 0 || j >= questions.length) return;
    const next = [...questions];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
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
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- no-stable-id
        <div key={i} className="rounded-lg border border-edge p-2.5 space-y-2">
          <div className="flex items-start gap-2">
            <Input
              value={q.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Question (e.g. What's the occasion?)"
            />
            <Select
              value={q.type}
              onValueChange={(v) => {
                const type = v as IntakeQuestion['type'];
                update(i, { type, options: type === 'choice' ? q.options ?? ['', ''] : undefined });
              }}
            >
              <SelectTrigger className="w-28 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">Text</SelectItem>
                <SelectItem value="choice">Choice</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              className="text-red-400 hover:text-red-300 shrink-0"
              aria-label={`Delete question ${i + 1}`}
              onClick={() => (questions[i].id ? setPendingRemove(i) : remove(i))}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={q.aiInstruction ?? ''}
              maxLength={200}
              onChange={(e) => update(i, { aiInstruction: e.target.value || undefined })}
              placeholder="How to ask (e.g. only if they mention a leak)"
            />
            <Input
              value={q.exampleAnswer ?? ''}
              maxLength={120}
              onChange={(e) => update(i, { exampleAnswer: e.target.value || undefined })}
              placeholder="Example answer (e.g. Second floor)"
            />
          </div>

          <div className="flex items-center gap-4 flex-wrap">
            {/*
              Disabled while the question is paused. "Required" and "Ask this" were
              independent, so an owner could mark a question required that the assistant
              never asks — a combination with no coherent meaning. The server now ignores
              the requirement for a paused question (it used to refuse every booking for
              the service), and the control says so rather than leaving the owner to infer it.
            */}
            <label
              htmlFor={`question-required-${i}`}
              className={cn('flex items-center gap-2', q.active === false ? 'opacity-50' : 'cursor-pointer')}
              title={q.active === false ? 'Not asked while this question is paused' : undefined}
            >
              <Checkbox
                id={`question-required-${i}`}
                checked={q.required && q.active !== false}
                disabled={q.active === false}
                onCheckedChange={(c) => update(i, { required: c === true })}
              />
              <span className="text-xs text-text-secondary">Required</span>
            </label>
            {/* Pause rather than delete: deleting orphans every answer already collected. */}
            <label htmlFor={`question-active-${i}`} className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                id={`question-active-${i}`}
                checked={q.active !== false}
                onCheckedChange={(c) => update(i, { active: c === true ? undefined : false })}
              />
              <span className="text-xs text-text-secondary">Ask this</span>
            </label>
            <label htmlFor={`question-calendar-${i}`} className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                id={`question-calendar-${i}`}
                checked={q.includeInCalendar !== false}
                onCheckedChange={(c) => update(i, { includeInCalendar: c === true ? undefined : false })}
              />
              <span className="text-xs text-text-secondary">Show on my calendar</span>
            </label>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-label={`Move question ${i + 1} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                aria-label={`Move question ${i + 1} down`}
                disabled={i === questions.length - 1}
                onClick={() => move(i, 1)}
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>

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

      {/*
        Answers are NOT deleted with the question — they live on each booking row. What is
        lost is the label they are shown under, so every historical answer starts rendering
        as a raw uuid. The copy says exactly that, because "are you sure?" tells an owner
        nothing they can weigh.
      */}
      <AlertDialog open={pendingRemove !== null} onOpenChange={(o) => !o && setPendingRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this question?</AlertDialogTitle>
            <AlertDialogDescription>
              Answers customers already gave are kept on their bookings, but they will show
              under an internal id instead of “{pendingRemove !== null ? questions[pendingRemove]?.label || 'this question' : ''}”.
              To stop asking it while keeping past answers readable, untick “Ask this” instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRemove !== null) remove(pendingRemove);
                setPendingRemove(null);
              }}
            >
              Delete question
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};


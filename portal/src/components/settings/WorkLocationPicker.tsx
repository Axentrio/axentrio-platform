/**
 * "Where do you work?" — asked once, then answered by the services themselves.
 *
 * The partner spec draws this as a setting the owner picks and the platform stores. It is not
 * stored, deliberately, and the reason is worth stating because the design looks like a
 * compromise until you see the failure it avoids: a `work_location` column would decide behaviour
 * independently of the Service catalog, and the catalog is where the facts already live. A
 * business whose column says "on the road" and whose services all say "customers come to me" has
 * two answers to one question, and every screen would have to pick a winner.
 *
 * So this control INITIALISES and never rewrites:
 *
 *   - No services yet → four options. Choosing one creates the first service(s) shaped to match.
 *     The owner answers the question they expect to be asked, and the answer becomes real data.
 *   - Services exist  → the derived value, read-only, with a line saying it follows the services.
 *     Changing it means editing a service, which is the only place the truth lives.
 *
 * "Both" is the case that has to be named rather than left to the reader: it creates TWO starter
 * services, one at the premises and one at the customer, because that is the only configuration
 * that actually produces `both`. A picker that said Both and quietly made one service would be
 * lying about what it did.
 */
import { useState } from 'react';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import type { Service, ServiceInput, WorkLocation } from '@/queries/useSchedulerQueries';

interface Props {
  workLocation: WorkLocation;
  services: Service[];
  /** Creates one service. Called twice for "Both". */
  onCreateService: (input: ServiceInput) => Promise<unknown>;
  disabled?: boolean;
}

/**
 * The four answers, each in one place.
 *
 * These began as three parallel records keyed by the same union - options, starter services and
 * read-only descriptions - which meant adding a fifth work location was three edits in three
 * shapes, and the wording drifted between two of them on the first day.
 *
 * `starters` are shapes rather than products; the owner renames and prices them.
 * `customerAddressRequired` is the field that actually decides the answer, because it gates
 * address collection, the travel gate, service-area checks and the calendar invite - so it is what
 * these set, and `locationType` follows it rather than the other way round.
 */
const ANSWERS: Array<{
  value: WorkLocation;
  label: string;
  /** Shown beside the button while choosing. */
  hint: string;
  /** Shown afterwards, when the services have taken over the answer. */
  settled: string;
  starters: ServiceInput[];
}> = [
  {
    value: 'no_location',
    label: 'No location',
    hint: 'Online only — nothing happens anywhere in particular.',
    settled: 'None of your services happen anywhere in particular.',
    // Nothing. There is no service shape meaning "we do not go anywhere", so inventing a
    // placeholder the owner then has to delete would be worse than an empty catalog.
    starters: [],
  },
  {
    value: 'at_one_location',
    label: 'At one location',
    hint: 'Customers come to you.',
    settled: 'Your customers come to you.',
    starters: [
      { name: 'Appointment', durationMin: 60, customerAddressRequired: false, locationType: 'in_person' },
    ],
  },
  {
    value: 'on_the_road',
    label: 'On the road',
    hint: 'You go to customers. Travel time plans your day around the driving.',
    settled: 'You travel to your customers.',
    starters: [
      { name: 'On-site visit', durationMin: 60, customerAddressRequired: true, locationType: 'in_person' },
    ],
  },
  {
    value: 'both',
    label: 'Both',
    hint: 'Some work happens at your place, some at theirs.',
    settled: 'Some services happen at your place, some at the customer’s.',
    // TWO services, one of each kind, because that is the only configuration that actually
    // derives to `both`. A picker that said Both and quietly made one would show a different
    // answer than the one that was clicked.
    starters: [
      { name: 'Appointment at our place', durationMin: 60, customerAddressRequired: false, locationType: 'in_person' },
      { name: 'On-site visit', durationMin: 60, customerAddressRequired: true, locationType: 'in_person' },
    ],
  },
];

const answerFor = (value: WorkLocation) => ANSWERS.find((a) => a.value === value) ?? ANSWERS[1];

export function WorkLocationPicker({ workLocation, services, onCreateService, disabled }: Props) {
  const [busy, setBusy] = useState<WorkLocation | null>(null);
  // The catalog is the source of truth, so its emptiness is what decides which half shows.
  const catalogEmpty = services.length === 0;

  const choose = async (value: WorkLocation) => {
    setBusy(value);
    try {
      // Sequentially, not in parallel: "Both" creates two services and they are ordered on screen
      // by creation. Racing them would sort the owner's catalog at random.
      const { starters } = answerFor(value);
      for (const starter of starters) await onCreateService(starter);
      if (starters.length) {
        toast.success(
          starters.length > 1
            ? 'Two services created — rename and price them below.'
            : 'A service was created — rename and price it below.'
        );
      } else {
        toast.success('Noted. You can add services below whenever you need them.');
      }
    } catch {
      // The mutation surfaces its own error; this only has to stop the spinner.
    } finally {
      setBusy(null);
    }
  };

  if (!catalogEmpty) {
    return (
      <div>
        <Label>Where do you work?</Label>
        <p className="text-sm text-text-secondary mt-1">{answerFor(workLocation).settled}</p>
        <p className="text-xs text-text-muted mt-1">
          This follows your services rather than being set on its own, so it can never disagree
          with them. To change it, change whether a service needs the customer’s address.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Label>Where do you work?</Label>
      <p className="text-xs text-text-muted mt-1 mb-2">
        This sets up your first service. You can change everything about it afterwards.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {ANSWERS.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={disabled || busy !== null}
            onClick={() => void choose(o.value)}
            className="text-left rounded-md border border-border px-3 py-2 hover:bg-surface-hover disabled:opacity-50"
          >
            <span className="text-sm font-medium">{busy === o.value ? 'Setting up…' : o.label}</span>
            <span className="block text-xs text-text-muted">{o.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

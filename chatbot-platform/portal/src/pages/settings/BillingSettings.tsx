/**
 * Billing settings — current plan, trial countdown, subscribe / change /
 * cancel actions, billing email editor, recent billing history.
 *
 * Plan: .scratch/plan-billing.md § Implementation outline step 11.
 *
 * UI state shapes:
 *   - Free / manual-trial (no Stripe sub): show "Subscribe" tiles.
 *   - Active Stripe sub: show current plan card with Change / Cancel /
 *     Manage payment-method actions; the change tiles show the other
 *     checkoutable plan as a target.
 *   - Cancelling: shows the cancel-on-date banner with an Undo button.
 *   - Pending change: shows the upcoming-plan banner with an Undo button.
 *   - Past-due: read-only banner, only "Manage payment method" is enabled.
 *   - Enterprise (manual): shows "Contact sales" tile only.
 */

import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownCircle,
  ArrowUpCircle,
  CheckCircle2,
  Clock,
  CreditCard,
  ExternalLink,
  Loader2,
  Mail,
  ReceiptText,
  Save,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  BillingState,
  BillingTier,
  CheckoutablePlan,
  useBillingState,
  useCancelSubscription,
  useChangePlan,
  useOpenPortal,
  useStartCheckout,
  useUndoCancel,
  useUndoPendingChange,
  useUpdateBillingEmail,
} from '@/queries/useBillingQueries';

// -- Plan catalog (display-only — server is source of truth for entitlements)
interface PlanCardData {
  id: BillingTier;
  name: string;
  price: string;
  blurb: string;
  features: string[];
}

const PLAN_DISPLAY: Record<BillingTier, PlanCardData> = {
  free: {
    id: 'free',
    name: 'Free',
    price: '$0/mo',
    blurb: 'Try out the basics on the house.',
    features: ['1 agent', '10 concurrent sessions', '1 channel', 'BYO LLM key'],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: '$49/mo',
    blurb: 'For growing teams.',
    features: [
      '3 agents',
      '100 concurrent sessions',
      '1,000 platform LLM calls/day',
      '3 channels',
      'File uploads & handoff',
    ],
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    price: '$199/mo',
    blurb: 'Custom branding + room to grow.',
    features: [
      '10 agents',
      '500 concurrent sessions',
      '10,000 platform LLM calls/day',
      'Unlimited channels',
      'Custom branding & domain',
      'Priority support',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Custom',
    blurb: 'Sales-managed, SLA support.',
    features: ['Unlimited everything', 'Custom integrations', 'SLA + dedicated support'],
  },
};

function StatusBadge({ status }: { status: BillingState['status'] }) {
  const map: Record<BillingState['status'], { label: string; cls: string }> = {
    trialing: { label: 'Trialing', cls: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
    active: { label: 'Active', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
    past_due: { label: 'Past due', cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
    cancelled: { label: 'Cancelled', cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
    none: { label: 'No plan', cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
  };
  const { label, cls } = map[status];
  return <Badge className={`border ${cls}`}>{label}</Badge>;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function daysBetween(from: Date, toIso: string): number {
  const to = new Date(toIso);
  const ms = to.getTime() - from.getTime();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

const TrialCountdown: React.FC<{ trialEnd: string }> = ({ trialEnd }) => {
  const days = daysBetween(new Date(), trialEnd);
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 text-sm">
      <Clock className="w-4 h-4" />
      <span>
        Trial ends {formatDate(trialEnd)} — <strong>{days}</strong>{' '}
        {days === 1 ? 'day' : 'days'} left
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Current plan card
// ---------------------------------------------------------------------------

const CurrentPlanCard: React.FC<{ state: BillingState }> = ({ state }) => {
  const plan = PLAN_DISPLAY[state.planId];
  return (
    <Card variant="glass">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary-400" />
            <h2 className="text-lg font-semibold text-text-primary">Current plan</h2>
          </div>
          <StatusBadge status={state.status} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4">
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-bold text-text-primary">{plan.name}</span>
            <span className="text-text-secondary">{plan.price}</span>
          </div>
          <p className="text-sm text-text-secondary">{plan.blurb}</p>
          {state.trialEnd && state.status === 'trialing' && (
            <TrialCountdown trialEnd={state.trialEnd} />
          )}
          {state.currentPeriodEnd && state.status === 'active' && !state.cancelAtPeriodEnd && (
            <div className="text-sm text-text-secondary">
              Renews on <strong>{formatDate(state.currentPeriodEnd)}</strong>
            </div>
          )}
          {state.cancelAtPeriodEnd && state.currentPeriodEnd && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
              <AlertTriangle className="w-4 h-4" />
              <span>
                Cancelling on <strong>{formatDate(state.currentPeriodEnd)}</strong> — you'll
                drop to Free after that.
              </span>
            </div>
          )}
          {state.pendingPlanId && state.pendingPlanEffectiveAt && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 text-sm">
              <ArrowDownCircle className="w-4 h-4" />
              <span>
                Switching to <strong>{PLAN_DISPLAY[state.pendingPlanId].name}</strong> on{' '}
                <strong>{formatDate(state.pendingPlanEffectiveAt)}</strong>
              </span>
            </div>
          )}
          {state.status === 'past_due' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              <AlertTriangle className="w-4 h-4" />
              <span>
                Payment failed — update your payment method to keep your subscription
                active.
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Actions: change plan, cancel, undo, manage payment method
// ---------------------------------------------------------------------------

const ActionRow: React.FC<{ state: BillingState }> = ({ state }) => {
  const changePlan = useChangePlan();
  const cancel = useCancelSubscription();
  const undoCancel = useUndoCancel();
  const undoPending = useUndoPendingChange();
  const openPortal = useOpenPortal();

  const handleManagePayment = () =>
    openPortal.mutate({ returnUrl: window.location.href });

  // Hide every Stripe-targeting action when the tenant has no Stripe sub —
  // matches the route layer's `no_stripe_subscription` rejection (HTTP 400).
  if (!state.hasStripeSubscription) return null;

  const showUndoCancel = state.cancelAtPeriodEnd;
  const showUndoPending = !!state.pendingPlanId;
  const showCancel = !state.cancelAtPeriodEnd && state.status !== 'cancelled';
  const targetPlan: CheckoutablePlan | null =
    state.planId === 'pro' ? 'premium' : state.planId === 'premium' ? 'pro' : null;
  const showChangePlan =
    targetPlan !== null && !state.pendingPlanId && state.status !== 'past_due';

  return (
    <Card variant="glass">
      <CardHeader>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <CreditCard className="w-5 h-5" />
          Manage subscription
        </h2>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {showChangePlan && targetPlan && (
            <Button
              variant="default"
              onClick={() => changePlan.mutate({ planId: targetPlan })}
              disabled={changePlan.isPending}
            >
              {changePlan.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : targetPlan === 'premium' ? (
                <ArrowUpCircle className="w-4 h-4" />
              ) : (
                <ArrowDownCircle className="w-4 h-4" />
              )}
              {targetPlan === 'premium' ? 'Upgrade to Premium' : 'Downgrade to Pro'}
            </Button>
          )}
          {showCancel && (
            <Button
              variant="ghost"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              {cancel.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Cancel subscription
            </Button>
          )}
          {showUndoCancel && (
            <Button
              variant="default"
              onClick={() => undoCancel.mutate()}
              disabled={undoCancel.isPending}
            >
              {undoCancel.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Resume subscription
            </Button>
          )}
          {showUndoPending && (
            <Button
              variant="ghost"
              onClick={() => undoPending.mutate()}
              disabled={undoPending.isPending}
            >
              {undoPending.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Undo pending change
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={handleManagePayment}
            disabled={openPortal.isPending}
          >
            {openPortal.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ExternalLink className="w-4 h-4" />
            )}
            Manage payment method
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Subscribe tiles (free / manual-trial → no Stripe sub yet)
// ---------------------------------------------------------------------------

const SubscribeTiles: React.FC<{ state: BillingState }> = ({ state }) => {
  const checkout = useStartCheckout();

  if (state.hasStripeSubscription) return null;
  if (state.tier === 'enterprise') {
    return (
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            Enterprise plan
          </h2>
        </CardHeader>
        <CardContent>
          <p className="text-text-secondary">
            Your account is on a sales-managed Enterprise plan. To make plan or billing
            changes, reach out to your account contact.
          </p>
          <Button asChild className="mt-4">
            <a href="mailto:sales@example.com">
              Contact sales
              <ExternalLink className="w-4 h-4 ml-1" />
            </a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const handleSubscribe = (planId: CheckoutablePlan) => {
    checkout.mutate({
      planId,
      successUrl: `${window.location.origin}/settings/billing?subscribed=1`,
      cancelUrl: window.location.href,
    });
  };

  // Hide the tile for the plan the tenant is already on — subscribing to
  // your current plan would just create a duplicate Stripe sub (which the
  // server's duplicate-checkout guard would also reject with 409, but the
  // UI shouldn't even offer it).
  const availablePlans = (['pro', 'premium'] as CheckoutablePlan[]).filter(
    (id) => id !== state.planId,
  );
  if (availablePlans.length === 0) return null;

  return (
    <div
      className={`grid gap-4 ${availablePlans.length === 1 ? 'md:grid-cols-1' : 'md:grid-cols-2'}`}
    >
      {availablePlans.map((planId) => {
        const plan = PLAN_DISPLAY[planId];
        return (
          <Card key={planId} variant="glass">
            <CardHeader>
              <div className="flex items-baseline justify-between">
                <h3 className="text-lg font-semibold text-text-primary">{plan.name}</h3>
                <span className="text-text-secondary">{plan.price}</span>
              </div>
              <p className="text-sm text-text-secondary">{plan.blurb}</p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5 mb-4">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm text-text-secondary">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button
                className="w-full"
                onClick={() => handleSubscribe(planId)}
                disabled={checkout.isPending}
              >
                {checkout.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : null}
                Subscribe to {plan.name}
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Billing email
// ---------------------------------------------------------------------------

const BillingEmailEditor: React.FC<{ state: BillingState }> = ({ state }) => {
  const [email, setEmail] = useState(state.billingEmail ?? '');
  const update = useUpdateBillingEmail();
  React.useEffect(() => {
    setEmail(state.billingEmail ?? '');
  }, [state.billingEmail]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || email === state.billingEmail) return;
    update.mutate(email);
  };

  return (
    <Card variant="glass">
      <CardHeader>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <Mail className="w-5 h-5" />
          Billing email
        </h2>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex gap-2 items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="billing-email" className="text-text-secondary">
              Invoices and receipts go here
            </Label>
            <Input
              id="billing-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="billing@your-company.com"
              required
            />
          </div>
          <Button
            type="submit"
            disabled={update.isPending || !email || email === state.billingEmail}
          >
            {update.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Billing history (last 20 events)
// ---------------------------------------------------------------------------

function describeEvent(eventType: string): string {
  const map: Record<string, string> = {
    'trial.created': 'Trial started',
    'trial.expired': 'Trial expired',
    'subscription.created': 'Subscription created',
    'subscription.updated': 'Subscription updated',
    'subscription.deleted': 'Subscription cancelled',
    'invoice.paid': 'Invoice paid',
    'invoice.payment_failed': 'Payment failed',
    'refund.recorded': 'Refund recorded',
    'billing.email.updated': 'Billing email updated',
    'tier.manual_override': 'Tier changed by admin',
  };
  return map[eventType] ?? eventType;
}

const BillingHistory: React.FC<{ state: BillingState }> = ({ state }) => {
  if (state.events.length === 0) {
    return (
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <ReceiptText className="w-5 h-5" />
            History
          </h2>
        </CardHeader>
        <CardContent>
          <p className="text-text-secondary text-sm">No billing activity yet.</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card variant="glass">
      <CardHeader>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <ReceiptText className="w-5 h-5" />
          History
        </h2>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-edge">
          {state.events.map((e) => (
            <li key={e.id} className="py-2.5 flex items-center justify-between text-sm">
              <div>
                <div className="text-text-primary">{describeEvent(e.eventType)}</div>
                <div className="text-text-muted text-xs">
                  {e.provider} · {new Date(e.createdAt).toLocaleString()}
                </div>
              </div>
              {(() => {
                const url = (e.payload as { invoiceUrl?: string | null })?.invoiceUrl;
                return url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary-400 hover:underline text-xs flex items-center gap-1"
                  >
                    View invoice <ExternalLink className="w-3 h-3" />
                  </a>
                ) : null;
              })()}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const BillingSettings: React.FC = () => {
  const { data: state, isLoading, isError, error } = useBillingState();

  const subscribedJustNow = useMemo(
    () => new URLSearchParams(window.location.search).get('subscribed') === '1',
    [],
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-text-secondary" />
      </div>
    );
  }
  if (isError || !state) {
    return (
      <Card variant="glass">
        <CardContent>
          <p className="text-red-400">
            Couldn't load billing state: {error instanceof Error ? error.message : 'unknown error'}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {subscribedJustNow && (
        <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4" />
          Subscription received — waiting for Stripe to confirm. This page will update
          automatically.
        </div>
      )}

      <CurrentPlanCard state={state} />
      <ActionRow state={state} />
      <SubscribeTiles state={state} />
      <BillingEmailEditor state={state} />
      <BillingHistory state={state} />
    </div>
  );
};

export default BillingSettings;

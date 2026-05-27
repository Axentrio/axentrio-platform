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
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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

// Self-serve plans in upgrade-rank order. Source of truth lives in
// `selfServePlans` from /entitlements; this ordering mirrors it and is used
// to label upgrades vs downgrades in the change-plan UI.
const SELF_SERVE_PLANS: CheckoutablePlan[] = ['essential', 'pro', 'enterprise'];
const planRank = (id: CheckoutablePlan): number => SELF_SERVE_PLANS.indexOf(id);

const getPlanDisplay = (t: TFunction): Record<BillingTier, PlanCardData> => ({
  free: {
    id: 'free',
    name: t('settings.billing.plans.free.name'),
    price: t('settings.billing.plans.free.price'),
    blurb: t('settings.billing.plans.free.blurb'),
    features: [
      t('settings.billing.plans.free.features.agents'),
      t('settings.billing.plans.free.features.sessions'),
      t('settings.billing.plans.free.features.channels'),
      t('settings.billing.plans.free.features.byoLlm'),
    ],
  },
  essential: {
    id: 'essential',
    name: t('settings.billing.plans.essential.name'),
    price: t('settings.billing.plans.essential.price'),
    blurb: t('settings.billing.plans.essential.blurb'),
    features: [
      t('settings.billing.plans.essential.features.agents'),
      t('settings.billing.plans.essential.features.sessions'),
      t('settings.billing.plans.essential.features.llmCalls'),
      t('settings.billing.plans.essential.features.channels'),
      t('settings.billing.plans.essential.features.uploadsHandoff'),
    ],
  },
  pro: {
    id: 'pro',
    name: t('settings.billing.plans.pro.name'),
    price: t('settings.billing.plans.pro.price'),
    blurb: t('settings.billing.plans.pro.blurb'),
    features: [
      t('settings.billing.plans.pro.features.agents'),
      t('settings.billing.plans.pro.features.sessions'),
      t('settings.billing.plans.pro.features.llmCalls'),
      t('settings.billing.plans.pro.features.channels'),
      t('settings.billing.plans.pro.features.branding'),
      t('settings.billing.plans.pro.features.support'),
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: t('settings.billing.plans.enterprise.name'),
    price: t('settings.billing.plans.enterprise.price'),
    blurb: t('settings.billing.plans.enterprise.blurb'),
    features: [
      t('settings.billing.plans.enterprise.features.unlimited'),
      t('settings.billing.plans.enterprise.features.integrations'),
      t('settings.billing.plans.enterprise.features.sla'),
    ],
  },
});

function StatusBadge({ status }: { status: BillingState['status'] }) {
  const { t } = useTranslation();
  const map: Record<BillingState['status'], { label: string; cls: string }> = {
    trialing: { label: t('settings.billing.status.trialing'), cls: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
    active: { label: t('settings.billing.status.active'), cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
    past_due: { label: t('settings.billing.status.pastDue'), cls: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
    cancelled: { label: t('settings.billing.status.cancelled'), cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
    none: { label: t('settings.billing.status.none'), cls: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
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
  const { t } = useTranslation();
  const days = daysBetween(new Date(), trialEnd);
  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 text-sm">
      <Clock className="w-4 h-4" />
      <span>
        {t('settings.billing.trial.endsInDays', {
          date: formatDate(trialEnd),
          count: days,
        })}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Current plan card
// ---------------------------------------------------------------------------

const CurrentPlanCard: React.FC<{ state: BillingState }> = ({ state }) => {
  const { t } = useTranslation();
  const planDisplay = getPlanDisplay(t);
  const plan = planDisplay[state.planId];
  return (
    <Card variant="glass">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary-400" />
            <h2 className="text-lg font-semibold text-text-primary">{t('settings.billing.currentPlan.title')}</h2>
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
              {t('settings.billing.currentPlan.renewsOn', {
                date: formatDate(state.currentPeriodEnd),
              })}
            </div>
          )}
          {state.cancelAtPeriodEnd && state.currentPeriodEnd && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm">
              <AlertTriangle className="w-4 h-4" />
              <span>
                {t('settings.billing.currentPlan.cancellingOn', {
                  date: formatDate(state.currentPeriodEnd),
                })}
              </span>
            </div>
          )}
          {state.pendingPlanId && state.pendingPlanEffectiveAt && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/30 text-blue-300 text-sm">
              <ArrowDownCircle className="w-4 h-4" />
              <span>
                {t('settings.billing.currentPlan.switchingTo', {
                  plan: planDisplay[state.pendingPlanId].name,
                  date: formatDate(state.pendingPlanEffectiveAt),
                })}
              </span>
            </div>
          )}
          {state.status === 'past_due' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-red-300 text-sm">
              <AlertTriangle className="w-4 h-4" />
              <span>
                {t('settings.billing.currentPlan.pastDueWarning')}
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
  const { t } = useTranslation();
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
  // Change-plan targets: every other self-serve plan. Hidden when a pending
  // change is already queued or when the sub is past_due (Stripe rejects
  // mid-dunning upgrades).
  const currentPlanId = state.planId as CheckoutablePlan;
  const isOnSelfServePlan = SELF_SERVE_PLANS.includes(currentPlanId);
  const changeTargets =
    isOnSelfServePlan && !state.pendingPlanId && state.status !== 'past_due'
      ? SELF_SERVE_PLANS.filter((id) => id !== currentPlanId)
      : [];
  const planDisplay = getPlanDisplay(t);

  return (
    <Card variant="glass">
      <CardHeader>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <CreditCard className="w-5 h-5" />
          {t('settings.billing.manage.title')}
        </h2>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {changeTargets.map((target) => {
            const isUpgrade = planRank(target) > planRank(currentPlanId);
            return (
              <Button
                key={target}
                variant="default"
                onClick={() => changePlan.mutate({ planId: target })}
                disabled={changePlan.isPending}
              >
                {changePlan.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : isUpgrade ? (
                  <ArrowUpCircle className="w-4 h-4" />
                ) : (
                  <ArrowDownCircle className="w-4 h-4" />
                )}
                {isUpgrade
                  ? t('settings.billing.manage.upgradeTo', { plan: planDisplay[target].name })
                  : t('settings.billing.manage.downgradeTo', { plan: planDisplay[target].name })}
              </Button>
            );
          })}
          {showCancel && (
            <Button
              variant="destructive"
              onClick={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              {cancel.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('settings.billing.manage.cancelSubscription')}
            </Button>
          )}
          {showUndoCancel && (
            <Button
              variant="default"
              onClick={() => undoCancel.mutate()}
              disabled={undoCancel.isPending}
            >
              {undoCancel.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('settings.billing.manage.resumeSubscription')}
            </Button>
          )}
          {showUndoPending && (
            <Button
              variant="ghost"
              onClick={() => undoPending.mutate()}
              disabled={undoPending.isPending}
            >
              {undoPending.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {t('settings.billing.manage.undoPendingChange')}
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
            {t('settings.billing.manage.managePaymentMethod')}
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
  const { t } = useTranslation();
  const planDisplay = getPlanDisplay(t);
  const checkout = useStartCheckout();

  if (state.hasStripeSubscription) return null;
  if (state.tier === 'enterprise') {
    return (
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <Sparkles className="w-5 h-5" />
            {t('settings.billing.enterprise.title')}
          </h2>
        </CardHeader>
        <CardContent>
          <p className="text-text-secondary">
            {t('settings.billing.enterprise.description')}
          </p>
          <Button asChild className="mt-4">
            <a href="mailto:sales@example.com">
              {t('settings.billing.enterprise.contactSales')}
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
  const availablePlans = SELF_SERVE_PLANS.filter((id) => id !== state.planId);
  if (availablePlans.length === 0) return null;
  const gridCols =
    availablePlans.length === 1
      ? 'md:grid-cols-1'
      : availablePlans.length === 2
        ? 'md:grid-cols-2'
        : 'md:grid-cols-3';

  return (
    <div className={`grid gap-4 ${gridCols}`}>
      {availablePlans.map((planId) => {
        const plan = planDisplay[planId];
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
                {t('settings.billing.subscribe.cta', { plan: plan.name })}
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
  const { t } = useTranslation();
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
          {t('settings.billing.email.title')}
        </h2>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex gap-2 items-end">
          <div className="flex-1 space-y-1">
            <Label htmlFor="billing-email" className="text-text-secondary">
              {t('settings.billing.email.label')}
            </Label>
            <Input
              id="billing-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('settings.billing.email.placeholder')}
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
            {t('common.save')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// Billing history (last 20 events)
// ---------------------------------------------------------------------------

function describeEvent(eventType: string, t: TFunction): string {
  const map: Record<string, string> = {
    'trial.created': t('settings.billing.history.events.trialCreated'),
    'trial.expired': t('settings.billing.history.events.trialExpired'),
    'subscription.created': t('settings.billing.history.events.subscriptionCreated'),
    'subscription.updated': t('settings.billing.history.events.subscriptionUpdated'),
    'subscription.deleted': t('settings.billing.history.events.subscriptionCancelled'),
    'invoice.paid': t('settings.billing.history.events.invoicePaid'),
    'invoice.payment_failed': t('settings.billing.history.events.invoicePaymentFailed'),
    'refund.recorded': t('settings.billing.history.events.refundRecorded'),
    'billing.email.updated': t('settings.billing.history.events.billingEmailUpdated'),
    'tier.manual_override': t('settings.billing.history.events.tierManualOverride'),
  };
  return map[eventType] ?? eventType;
}

const BillingHistory: React.FC<{ state: BillingState }> = ({ state }) => {
  const { t } = useTranslation();
  if (state.events.length === 0) {
    return (
      <Card variant="glass">
        <CardHeader>
          <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
            <ReceiptText className="w-5 h-5" />
            {t('settings.billing.history.title')}
          </h2>
        </CardHeader>
        <CardContent>
          <p className="text-text-secondary text-sm">{t('settings.billing.history.empty')}</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card variant="glass">
      <CardHeader>
        <h2 className="text-lg font-semibold text-text-primary flex items-center gap-2">
          <ReceiptText className="w-5 h-5" />
          {t('settings.billing.history.title')}
        </h2>
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-edge">
          {state.events.map((e) => (
            <li key={e.id} className="py-2.5 flex items-center justify-between text-sm">
              <div>
                <div className="text-text-primary">{describeEvent(e.eventType, t)}</div>
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
                    {t('settings.billing.history.viewInvoice')} <ExternalLink className="w-3 h-3" />
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
  const { t } = useTranslation();
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
            {t('settings.billing.loadError', {
              error: error instanceof Error ? error.message : t('settings.billing.unknownError'),
            })}
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
          {t('settings.billing.subscribedJustNow')}
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

/**
 * Platform LLM health probe.
 *
 * On 2026-08-03 the platform OpenAI key hit `credit_balance_exhausted`. Every
 * tenant's bot stopped answering — an agent error per turn, each one parked as a
 * `bot_error` handoff, each customer left on "Something went wrong". Nothing
 * alerted. It surfaced when a customer complained to a customer, who messaged the
 * founder on Telegram. We still cannot say how long it ran: the last successful
 * agent run was 13 hours before the first recorded error, and nothing in between
 * asked the provider whether it was alive.
 *
 * No tenant supplies its own key (verified in production), so the platform key is
 * a single point of failure for the whole product. This probe makes that failure
 * announce itself.
 *
 * Deliberately a REAL completion, not a credits/balance API call: it exercises
 * exactly the path a customer turn takes — key validity, model access, billing —
 * and needs no extra credential. One token, cheapest model, so running it every
 * few minutes costs a rounding error against a single customer conversation.
 */
import { getProvider } from './provider-factory';
import { DEFAULT_MODEL } from './defaults';
import { isUpstreamQuotaExhausted, isUpstreamRateLimit } from './upstream-error';
import { getEmailService } from '../automations';
import { logger } from '../utils/logger';

export type ProviderHealth =
  /** A completion came back. */
  | { state: 'ok' }
  /** Out of credit / over quota. Will NOT recover without a human paying. */
  | { state: 'quota_exhausted'; detail: string }
  /** Busy or throttled. Expected to clear on its own; not an outage. */
  | { state: 'rate_limited'; detail: string }
  /** Bad key, model gone, provider down — anything else. */
  | { state: 'unreachable'; detail: string };

/** Read per alert, not captured at module load, so changing the Railway variable
 *  takes effect without waiting for a restart to notice it. */
const alertInbox = (): string =>
  process.env.PLATFORM_ALERT_EMAIL?.trim()
  || process.env.SUPPORT_EMAIL?.trim()
  || 'support@axentrio.com';

/** One real, minimal completion against the PLATFORM key. Never throws. */
export async function probeProviderHealth(): Promise<ProviderHealth> {
  try {
    // No tenantId: skip the per-tenant rate-limit wrapper, so a busy tenant's
    // budget can never make the platform look unhealthy.
    const provider = getProvider({ path: 'health_probe' });
    await provider.chat([{ role: 'user', content: 'ping' }], {
      model: DEFAULT_MODEL,
      // Not 1. A gpt-5 model rejects a 1-token ceiling outright ("Could not
      // finish the message because max_tokens or model output limit was
      // reached"), which this function would classify as `unreachable` and
      // alert on — a false outage every five minutes. Small enough to stay
      // cheap, large enough for any model to say something.
      maxTokens: 16,
      temperature: 0,
      jsonMode: false,
    });
    return { state: 'ok' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Order matters: a quota failure IS a 429, so it must be classified first or
    // it reads as ordinary throttling and never alerts — which is exactly how the
    // 2026-08-03 outage stayed invisible.
    if (isUpstreamQuotaExhausted(err)) return { state: 'quota_exhausted', detail };
    if (isUpstreamRateLimit(err)) return { state: 'rate_limited', detail };
    return { state: 'unreachable', detail };
  }
}

/**
 * Alert state. Alerts on the TRANSITION into a bad state and again on recovery,
 * never on every tick — a five-minute probe would otherwise send 288 identical
 * emails a day and train everyone to filter them.
 */
let lastAlertedState: ProviderHealth['state'] = 'ok';

/**
 * A healthy probe is deliberately silent — but silence is also what a probe that
 * never started looks like, and a monitor you cannot tell is running is not a
 * monitor. Log the FIRST result at boot, whatever it is, so "the watchdog is
 * alive" is verifiable without waiting for an outage to prove it.
 */
let loggedFirstResult = false;

/** Reset between tests. */
export function __resetProviderHealthAlertState(): void {
  lastAlertedState = 'ok';
  loggedFirstResult = false;
}

/**
 * Send one alert, and answer whether it actually went.
 *
 * THE RETURN VALUE IS LOAD-BEARING. `EmailService.send` does NOT throw when delivery fails - an
 * unconfigured Resend key comes back as `{ success: false, error: 'not configured' }` and a
 * provider error the same way. A `try`/`catch` alone therefore treats the two LIKELIEST delivery
 * failures as successes, and the caller then advances `lastAlertedState` as though the outage had
 * been announced. Nobody was told, and the transition is spent: this probe would never mention it
 * again. That is the 2026-08-03 outage rebuilt inside the thing written to prevent it.
 */
async function alert(subject: string, body: string): Promise<boolean> {
  try {
    const result = await getEmailService().send({ to: alertInbox(), subject, body });
    if (result?.success === false) {
      // An alert that cannot be delivered must still be findable in the logs.
      logger.error('[provider-health] ALERT DELIVERY FAILED', { subject, error: result.error });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('[provider-health] ALERT DELIVERY FAILED', {
      subject,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Probe once and alert on a state change. Returns the health so callers (and the
 * admin observability endpoint) can surface it.
 */
export async function runProviderHealthCheck(): Promise<ProviderHealth> {
  const health = await probeProviderHealth();

  if (!loggedFirstResult) {
    loggedFirstResult = true;
    logger.info('[provider-health] probe active', { state: health.state, inbox: alertInbox() });
  }

  // Transient throttling is normal under load and is not an outage — never alert
  // on it, and never let it clear a standing quota alert.
  if (health.state === 'rate_limited') return health;

  if (health.state === lastAlertedState) return health;

  let delivered = true;

  if (health.state === 'ok') {
    logger.info('[provider-health] provider recovered', { previous: lastAlertedState });
    await alert(
      'Axentrio: AI provider recovered',
      `The platform LLM provider is answering again (was: ${lastAlertedState}).`,
    );
    // Deliberately NOT gated on delivery, unlike the failure branches below. Holding the state at
    // the old bad value to retry an all-clear would mean the NEXT outage matches it and is
    // silent - trading a missed recovery notice for a missed outage, which is the wrong way
    // round. The log line above is the record that it did not go.
  } else if (health.state === 'quota_exhausted') {
    logger.error('[provider-health] PLATFORM LLM OUT OF CREDIT — every tenant is down', {
      detail: health.detail,
    });
    delivered = await alert(
      'Axentrio URGENT: AI is down — platform key out of credit',
      [
        'The platform OpenAI key is out of credit or over its quota.',
        '',
        'EVERY tenant\'s bot is failing right now: each customer turn errors, the',
        'session is parked as a handoff, and the customer sees "Something went wrong".',
        'No tenant has its own key, so there is no partial degradation — it is all of them.',
        '',
        'Fix: add credit at https://platform.openai.com/settings/organization/billing',
        '',
        `Provider said: ${health.detail}`,
      ].join('\n'),
    );
  } else {
    logger.error('[provider-health] platform LLM unreachable', { detail: health.detail });
    delivered = await alert(
      'Axentrio: AI provider unreachable',
      `The platform LLM provider is not answering.\n\nProvider said: ${health.detail}`,
    );
  }

  // Only a DELIVERED alert spends the transition. Advancing after a failed send would record the
  // outage as announced while nobody had been told, and this probe would never raise it again -
  // the state would match on every subsequent tick. Left unadvanced, the next tick retries.
  if (delivered) lastAlertedState = health.state;
  return health;
}

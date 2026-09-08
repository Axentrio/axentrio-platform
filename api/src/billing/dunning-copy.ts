import { config } from '../config/environment';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type CopyLocale = 'en' | 'nl' | 'fr';

function copyLocale(locale: string): CopyLocale {
  if (locale === 'nl' || locale === 'fr') return locale;
  return 'en';
}

export function renderDunningEmail(input: {
  locale: string;
  day: 0 | 1 | 2;
  plan: string;
  graceEndsAt: Date;
}): { subject: string; body: string } {
  const daysLeft = 3 - input.day;
  const locale = copyLocale(input.locale);
  const graceDate = input.graceEndsAt.toISOString().slice(0, 10);
  const plan = escapeHtml(input.plan);
  const billingUrl = escapeHtml(`${config.portal.url}/settings/billing`);

  const subject =
    locale === 'nl'
      ? `Betaling mislukt — nog ${daysLeft} dagen om je kaart bij te werken`
      : locale === 'fr'
        ? `Paiement échoué — ${daysLeft} jours pour mettre à jour votre carte`
        : daysLeft === 1
          ? 'Payment failed — 1 day left to update your card'
          : `Payment failed — ${daysLeft} days left to update your card`;

  const body =
    locale === 'nl'
      ? `<p>We konden je kaart niet belasten voor ${plan}.</p><p>Werk je betaalmethode bij vóór ${graceDate}, anders valt je workspace terug op Free.</p><p><a href="${billingUrl}">Betaalmethode bijwerken</a></p>`
      : locale === 'fr'
        ? `<p>Nous n’avons pas pu débiter votre carte pour ${plan}.</p><p>Mettez à jour votre moyen de paiement avant le ${graceDate} ou l’espace passera à Free.</p><p><a href="${billingUrl}">Mettre à jour le moyen de paiement</a></p>`
        : `<p>We could not charge your card for ${plan}.</p><p>Update your payment method by ${graceDate} or your workspace drops to Free.</p><p><a href="${billingUrl}">Update payment method</a></p>`;

  return { subject, body };
}

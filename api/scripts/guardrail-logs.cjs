#!/usr/bin/env node
/**
 * Guardrails operations dashboard — summarise the two guardrail decision logs so
 * you can watch precision before flipping `Tenant.settings.guardrails.enforce`.
 *
 *   guardrail_spam_logs    — inbound gate (Slice 1: spam/scam/phishing/bot-loop)
 *   guardrail_output_logs  — output gate (Slice 2: leaked internals / plan
 *                            leakage / credential solicitation / unsafe links)
 *
 * Both run SHADOW-first: a row with enforced=false is a "would have blocked"
 * observation (nothing was changed). Read the `reasons` to judge true vs false
 * positives, then enable enforce per tenant once precision looks good.
 *
 * Usage (against prod, via Railway-injected DATABASE_URL):
 *   railway run -s chatbot-api -- node scripts/guardrail-logs.cjs
 *   railway run -s chatbot-api -- node scripts/guardrail-logs.cjs --days 7
 */
const { Client } = require('pg');

const daysArg = process.argv.indexOf('--days');
const days = daysArg !== -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set (run via `railway run -s chatbot-api -- node ...`).');
    process.exit(1);
  }
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  const since = `now() - interval '${days} days'`;

  const q = (sql) => c.query(sql).then((r) => r.rows);
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');

  console.log(`\n=== Guardrails logs — last ${days} days ===\n`);

  // ---- Inbound (spam/scam) ----
  const spamTotal = (await q(`SELECT count(*)::int n FROM guardrail_spam_logs WHERE created_at > ${since}`))[0].n;
  console.log(`INBOUND (guardrail_spam_logs): ${spamTotal} events`);
  if (spamTotal) {
    console.table(await q(
      `SELECT detected_category AS category, enforced, count(*)::int AS n
         FROM guardrail_spam_logs WHERE created_at > ${since}
        GROUP BY 1,2 ORDER BY 3 DESC`));
    console.log('  by tenant:');
    console.table(await q(
      `SELECT tenant_id, count(*)::int AS n, sum((enforced)::int)::int AS enforced
         FROM guardrail_spam_logs WHERE created_at > ${since}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 15`));
    console.log('  recent:');
    console.table(await q(
      `SELECT to_char(created_at,'MM-DD HH24:MI') AS t, source_channel AS ch,
              detected_category AS cat, enforced, reasons
         FROM guardrail_spam_logs WHERE created_at > ${since}
        ORDER BY created_at DESC LIMIT 15`));
  }

  // ---- Output ----
  const outTotal = (await q(`SELECT count(*)::int n FROM guardrail_output_logs WHERE created_at > ${since}`))[0].n;
  console.log(`\nOUTPUT (guardrail_output_logs): ${outTotal} events`);
  if (outTotal) {
    const enf = (await q(`SELECT sum((enforced)::int)::int n FROM guardrail_output_logs WHERE created_at > ${since}`))[0].n || 0;
    console.log(`  enforced (reply replaced): ${enf} / ${outTotal} (${pct(enf, outTotal)}); the rest are shadow observations`);
    console.log('  by generation path:');
    console.table(await q(
      `SELECT generation_path AS path, enforced, count(*)::int AS n
         FROM guardrail_output_logs WHERE created_at > ${since}
        GROUP BY 1,2 ORDER BY 3 DESC`));
    console.log('  by family:');
    console.table(await q(
      `SELECT fam AS family, count(*)::int AS n
         FROM guardrail_output_logs, jsonb_array_elements_text(families) AS fam
        WHERE created_at > ${since} GROUP BY 1 ORDER BY 2 DESC`));
    console.log('  recent:');
    console.table(await q(
      `SELECT to_char(created_at,'MM-DD HH24:MI') AS t, generation_path AS path,
              families, enforced, reasons
         FROM guardrail_output_logs WHERE created_at > ${since}
        ORDER BY created_at DESC LIMIT 15`));
  }

  console.log('');
  await c.end();
}

main().catch((e) => {
  console.error('guardrail-logs failed:', e.message);
  process.exit(1);
});

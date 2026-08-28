/**
 * Offline extraction eval — `npm run eval:leads`.
 *
 * Makes REAL model calls against the committed fixtures and scores them against
 * published thresholds, so "the extractor is accurate enough and does not fabricate"
 * is a measurement anyone can re-run rather than a claim. Requires OPENAI_API_KEY.
 *
 * Scoring asymmetry is deliberate:
 *   - recall has a threshold (some misses are acceptable; abstention is safe)
 *   - abstention violations have a ceiling of ZERO — each one is a fabricated fact
 *     about a named person, a successful injection, or special-category data persisted
 *
 * NOTE: `api/.env` points at PRODUCTION. This script only reads an LLM key and touches
 * no database, but run it with an explicit env if in doubt.
 */
import { extractLead } from '../extractor.service';
import { PLATFORM_TENANT_SENTINEL } from '../../../database/entities/LlmUsageDaily';
import { EVAL_CASES, EVAL_THRESHOLDS, type EvalCase } from './fixtures';
import type { ExtractedLead } from '../extractor.service';

interface CaseResult {
  name: string;
  language: string;
  recallHits: number;
  recallTotal: number;
  abstainViolations: string[];
  recallMisses: string[];
  falsePositiveRecord: boolean;
}

function scoreCase(c: EvalCase, out: ExtractedLead): CaseResult {
  const got: Record<string, string | null> = {
    request: out.request,
    address: out.address,
    serviceRequested: out.serviceRequested,
    urgency: out.urgency,
    intent: out.intent,
    preferredAt: out.preferredAtText,
  };

  let recallHits = 0;
  let recallTotal = 0;
  const recallMisses: string[] = [];
  for (const [field, expected] of Object.entries(c.expect.required ?? {})) {
    recallTotal += 1;
    const actual = got[field];
    if (actual && actual.toLowerCase().includes(String(expected).toLowerCase())) recallHits += 1;
    // Name the miss: "recall 4/5" is not actionable without knowing which one.
    else recallMisses.push(`${field}: wanted ~"${expected}", got ${actual === null ? 'null' : `"${actual}"`}`);
  }

  const abstainViolations: string[] = [];
  for (const field of c.expect.mustAbstain ?? []) {
    if (got[field]) abstainViolations.push(`${field}="${got[field]}"`);
  }
  // Forbidden VALUES, where abstention is not the right bar. "It's not urgent" should
  // read as `routine`; only the inversion to urgent/emergency is a failure.
  for (const [field, forbidden] of Object.entries(c.expect.mustNotBe ?? {})) {
    const actual = got[field];
    if (actual && (forbidden as readonly string[]).includes(actual)) {
      abstainViolations.push(`${field}="${actual}" (forbidden)`);
    }
  }

  // Denied content must not survive in ANY field, whichever one the model chose.
  for (const needle of c.expect.mustNotContain ?? []) {
    for (const [field, value] of Object.entries(got)) {
      if (value && value.toLowerCase().includes(needle.toLowerCase())) {
        abstainViolations.push(`${field} contains "${needle}"`);
      }
    }
  }

  const falsePositiveRecord = c.expect.fullyAbstains === true && !out.abstained;

  return {
    name: c.name,
    language: c.language,
    recallHits,
    recallTotal,
    abstainViolations,
    recallMisses,
    falsePositiveRecord,
  };
}

export async function runEval(): Promise<{ pass: boolean; results: CaseResult[]; summary: string }> {
  const results: CaseResult[] = [];
  for (const c of EVAL_CASES) {
    const out = await extractLead(PLATFORM_TENANT_SENTINEL, c.messages);
    results.push(scoreCase(c, out));
  }

  const recallHits = results.reduce((n, r) => n + r.recallHits, 0);
  const recallTotal = results.reduce((n, r) => n + r.recallTotal, 0);
  const recall = recallTotal === 0 ? 1 : recallHits / recallTotal;
  const violations = results.flatMap((r) => r.abstainViolations.map((v) => `${r.name}: ${v}`));
  const falsePositives = results.filter((r) => r.falsePositiveRecord);

  const pass =
    recall >= EVAL_THRESHOLDS.minRecall &&
    violations.length <= EVAL_THRESHOLDS.maxAbstainViolations &&
    falsePositives.length <= EVAL_THRESHOLDS.maxFalsePositiveRecords;

  const summary = [
    `cases:                 ${results.length}`,
    `recall:                ${recallHits}/${recallTotal} (${(recall * 100).toFixed(1)}%)  threshold ≥${(EVAL_THRESHOLDS.minRecall * 100).toFixed(0)}%`,
    `abstain violations:    ${violations.length}  threshold ≤${EVAL_THRESHOLDS.maxAbstainViolations}`,
    `false-positive records: ${falsePositives.length}  threshold ≤${EVAL_THRESHOLDS.maxFalsePositiveRecords}`,
    results.flatMap((r) => r.recallMisses.map((m) => `${r.name}: ${m}`)).length
      ? `\nRECALL MISSES:\n  ${results.flatMap((r) => r.recallMisses.map((m) => `${r.name}: ${m}`)).join('\n  ')}`
      : '',
    violations.length ? `\nVIOLATIONS (each is a fabricated fact, an injection, or Art 9 data):\n  ${violations.join('\n  ')}` : '',
    falsePositives.length ? `\nFALSE POSITIVES:\n  ${falsePositives.map((f) => f.name).join('\n  ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { pass, results, summary };
}

// Executed directly (npm run eval:leads), not on import.
if (require.main === module) {
  runEval()
    .then(({ pass, summary }) => {
      // eslint-disable-next-line no-console
      console.log(`\n=== lead extraction eval ===\n${summary}\n\n${pass ? 'PASS' : 'FAIL'}\n`);
      process.exit(pass ? 0 : 1);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('eval failed to run:', err);
      process.exit(1);
    });
}

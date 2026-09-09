import { AppDataSource } from "../database/data-source";
import { CanonicalTopic } from "../database/entities/CanonicalTopic";
import { Gap } from "../database/entities/Gap";
import { Judgment } from "../database/entities/Judgment";
import { DEFAULT_MODEL } from "../llm/defaults";
import { getProvider } from "../llm/provider-factory";
import { logger } from "../utils/logger";
import type { UsageTally } from "./judge.service";
import { containsContactData } from "./contact-in-text";

const MAX_RECOMMENDATIONS_PER_RUN = 10;
const RECOMMENDATION_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

function oneSentence(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const end = normalized.search(/[.!?](?:\s|$)/);
  return normalized
    .slice(0, end >= 0 ? end + 1 : 160)
    .slice(0, 160)
    .trim();
}

/** Generate bounded, grounded actions for stale open Pro+ Gaps with evidence. */
export async function generateGapRecommendations(
  tenantId: string,
  tally?: UsageTally,
  now = new Date(),
): Promise<void> {
  const gapRepo = AppDataSource.getRepository(Gap);
  // Bounded read: only MAX_RECOMMENDATIONS_PER_RUN gaps can be acted on per run
  // anyway, and the newest-seen gaps are the ones worth an action. The cap is far
  // above a real tenant's topic count — it exists so this can never load a whole
  // table into the process.
  const gaps = await gapRepo.find({
    where: { tenantId },
    order: { lastSeenAt: "DESC" },
    take: 500,
  });
  let attempts = 0;

  for (const gap of gaps) {
    if (gap.status !== "open") {
      if (gap.recommendation) {
        gap.recommendation = null;
        gap.recommendationUpdatedAt = null;
        await gapRepo.save(gap);
      }
      continue;
    }
    // Every later exit of this loop leaves the stored sentence in place, so a
    // value that carries a contact value is removed here, before any of them.
    if (gap.recommendation && containsContactData(gap.recommendation)) {
      gap.recommendation = null;
      gap.recommendationUpdatedAt = null;
      await gapRepo.save(gap);
    }
    if (
      gap.recommendation &&
      gap.recommendationUpdatedAt &&
      gap.recommendationUpdatedAt.getTime() >
        now.getTime() - RECOMMENDATION_FRESH_MS
    ) {
      continue;
    }
    if (attempts >= MAX_RECOMMENDATIONS_PER_RUN) continue;

    try {
      const topic = await AppDataSource.getRepository(CanonicalTopic).findOne({
        where: { id: gap.canonicalTopicId, tenantId },
        select: ["topic"],
      });
      if (!topic) continue;

      const judgments = await AppDataSource.getRepository(Judgment)
        .createQueryBuilder("j")
        .where("j.tenant_id = :tenantId", { tenantId })
        .andWhere("j.canonical_topic_id = :topicId", {
          topicId: gap.canonicalTopicId,
        })
        .andWhere("j.satisfied = false")
        // Only recent evidence: a gap open for 14 days must not recommend from
        // stale reasoning captured in the first week (review round 3, finding 3).
        .andWhere("j.session_started_at >= :evidenceCutoff", {
          evidenceCutoff: new Date(now.getTime() - RECOMMENDATION_FRESH_MS),
        })
        .orderBy("j.session_started_at", "DESC")
        .limit(3)
        .getMany();
      const evidence = judgments
        .map((judgment) => judgment.reasoning?.trim())
        .filter((reasoning): reasoning is string => Boolean(reasoning));
      if (evidence.length === 0) continue;
      attempts += 1;

      const response = await getProvider({
        path: "insights_gap_recommendation",
        tenantId,
      }).chat(
        [
          {
            role: "system",
            content:
              "Write one plain-English action sentence (maximum 160 characters) that helps a small-business owner close an unanswered customer topic. " +
              "Use only the supplied topic and evidence. Start with a verb. No greeting, markdown, or invented details. " +
              "Never include an email address or phone number.",
          },
          {
            role: "user",
            content: JSON.stringify({
              topic: topic.topic,
              occurrences: gap.occurrences,
              evidence,
            }),
          },
        ],
        {
          model: DEFAULT_MODEL,
          maxTokens: 80,
          temperature: 0,
          jsonMode: false,
        },
      );

      if (tally) {
        tally.promptTokens += response.usage.promptTokens;
        tally.completionTokens += response.usage.completionTokens;
        tally.calls += 1;
      }

      const recommendation = oneSentence(response.content);
      if (!recommendation) continue;
      // The model can copy a contact value out of the evidence. An insight
      // store is presented as aggregate, so the sentence is dropped.
      if (containsContactData(recommendation)) continue;
      gap.recommendation = recommendation;
      gap.recommendationUpdatedAt = now;
      await gapRepo.save(gap);
    } catch (error) {
      // Suggestions must never freeze the Judgment watermark.
      logger.warn("[insights-recommendation] generation failed", {
        tenantId,
        gapId: gap.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}

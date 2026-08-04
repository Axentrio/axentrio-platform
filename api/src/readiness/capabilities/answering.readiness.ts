/**
 * Answering readiness — can this bot actually answer a question about the
 * business?
 *
 * Every check here maps to a real incident, not a hypothetical:
 *
 *   - A bot whose knowledge base held no indexed content answered "Valyro biedt
 *     diensten aan op het gebied van [specifieke diensten niet vermeld]" to a
 *     prospect. The portal showed the bot as configured and the document as
 *     "Indexed"; nothing said the bot could not reach it.
 *   - A document sits in the KB with chunkCount 0 for a while after upload. Until
 *     it has chunks it is not retrievable, so "uploaded" is not "usable".
 *   - A bot whose bound template is archived or has no published version falls
 *     back to a generic service-business core. It still talks; it just stops
 *     being the business.
 *   - A template can declare {placeholders} the tenant never filled. Those render
 *     as blanks mid-sentence in a live reply.
 *
 * `live` means the bot can ground an answer in the tenant's own content. It is
 * deliberately NOT "the bot replies" — a bot with no knowledge replies fluently
 * and says nothing true, which is the failure that took days to notice.
 */
import { AppDataSource } from '../../database/data-source';
import { KnowledgeDocument } from '../../database/entities/KnowledgeDocument';
import { getBotKnowledgeBaseIds } from '../../knowledge/bot-knowledge-bases';
import { resolveBoundTemplates } from '../../templates/template-resolver';
import {
  registerCapability,
  type CapabilityReadiness,
  type ReadinessBotCtx,
  type ReadinessResult,
} from '../registry';

const KB_ROUTE = '/ai';

export const answeringReadiness: CapabilityReadiness = {
  key: 'answering',

  // Answering is the baseline every bot does — there is no entitlement that
  // switches it off, so this always applies. A bot with AI disabled is surfaced
  // by its own missing step rather than hidden, because "my bot is silent" is
  // exactly when someone opens this page.
  appliesTo(): boolean {
    return true;
  },

  async check(ctx: ReadinessBotCtx): Promise<ReadinessResult[]> {
    const missingSteps: ReadinessResult['missingSteps'] = [];
    const attention: NonNullable<ReadinessResult['attention']> = [];

    if (ctx.bot.settings?.ai?.enabled !== true) {
      missingSteps.push({
        id: 'ai_disabled',
        label: 'AI replies are switched off for this bot',
        cta: { route: `/ai/bots/${ctx.bot.id}`, label: 'Turn on AI' },
      });
    }

    // Retrieval is scoped to the bot's ATTACHED knowledge bases — a tenant-wide
    // document the bot is not attached to is unreachable, which is not visible
    // anywhere else in the portal.
    const kbIds = await getBotKnowledgeBaseIds(AppDataSource, ctx.bot.id);
    const docs = kbIds.length
      ? await AppDataSource.getRepository(KnowledgeDocument).find({
          where: kbIds.map((id) => ({ knowledgeBaseId: id })),
          select: ['id', 'status', 'chunkCount'],
        })
      : [];

    // "Indexed" is the document's own status; chunks are what retrieval reads.
    // A doc with zero chunks is still being processed and cannot be answered from.
    const retrievable = docs.filter((d) => d.status === 'indexed' && (d.chunkCount ?? 0) > 0);
    const stillProcessing = docs.filter((d) => (d.chunkCount ?? 0) === 0 && d.status !== 'failed');
    const failed = docs.filter((d) => d.status === 'failed');

    if (retrievable.length === 0) {
      missingSteps.push({
        id: 'no_knowledge',
        label:
          docs.length === 0
            ? 'No knowledge for this bot to answer from'
            : 'No document has finished indexing yet, so the bot cannot answer from any of them',
        cta: { route: KB_ROUTE, label: 'Add knowledge' },
      });
    } else if (stillProcessing.length > 0) {
      attention.push({
        code: 'documents_indexing',
        label: `${stillProcessing.length} document(s) not retrievable yet — still indexing`,
        cta: { route: KB_ROUTE, label: 'View knowledge' },
      });
    }

    if (failed.length > 0) {
      attention.push({
        code: 'documents_failed',
        label: `${failed.length} document(s) failed to index and will never be answered from`,
        cta: { route: KB_ROUTE, label: 'View knowledge' },
      });
    }

    // Template health. Unavailable ⇒ the runtime silently substitutes a generic
    // core, so the bot keeps talking while no longer representing the business.
    const resolved = await resolveBoundTemplates(ctx.bot);
    const primary = resolved[0];
    if (!primary || !primary.templateId) {
      attention.push({
        code: 'no_template',
        label: 'No speciality bound — the bot uses a generic service-business identity',
        cta: { route: `/ai/bots/${ctx.bot.id}`, label: 'Choose a speciality' },
      });
    } else if (primary.templateUnavailable) {
      missingSteps.push({
        id: 'template_unavailable',
        label: 'The bound speciality is archived or unpublished — the bot fell back to a generic identity',
        cta: { route: `/ai/bots/${ctx.bot.id}`, label: 'Fix the speciality' },
      });
    } else if (primary.pinnedButUnavailable) {
      attention.push({
        code: 'pinned_version_gone',
        label: 'The pinned version is no longer published — using the latest instead',
        cta: { route: `/ai/bots/${ctx.bot.id}`, label: 'Review the speciality' },
      });
    }

    // Declared-but-unfilled {placeholders} render as blanks mid-sentence.
    const filled = (ctx.bot.settings?.ai as { templateVariables?: Record<string, string> } | undefined)
      ?.templateVariables ?? {};
    const unfilled = (primary?.variables ?? [])
      .filter((v) => {
        const value = filled[v.key] ?? (typeof v.default === 'string' ? v.default : '');
        return value.trim().length === 0;
      })
      .map((v) => v.key);
    if (unfilled.length > 0) {
      attention.push({
        code: 'unfilled_variables',
        label: `Speciality details not filled in: ${unfilled.join(', ')} — these appear blank in replies`,
        cta: { route: `/ai/bots/${ctx.bot.id}`, label: 'Fill in the details' },
      });
    }

    return [
      {
        capability: 'answering',
        state: missingSteps.length === 0 ? 'live' : 'not_ready',
        missingSteps,
        attention: attention.length ? attention : undefined,
        detail: {
          retrievableDocuments: retrievable.length,
          documentsIndexing: stillProcessing.length,
          documentsFailed: failed.length,
          knowledgeBasesAttached: kbIds.length,
          templateId: primary?.templateId ?? null,
          resolvedTemplateVersion: primary?.resolvedVersion ?? null,
        },
      },
    ];
  },
};

registerCapability(answeringReadiness);

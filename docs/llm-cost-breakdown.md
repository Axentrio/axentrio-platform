# LLM cost breakdown

**Written:** 2026-08-27. **Prices retrieved August 2026.**

This document records every LLM and embedding spend path in the API. It uses
OpenAI list prices in USD per 1 million tokens. Batch halves every rate. Fast
doubles every rate. The platform default model is `gpt-5.6-luna`.

Embeddings stay on `text-embedding-3-large`. There is no newer OpenAI embedding
model as of August 2026.

## 1. Price table

| Model | Input | Output |
|---|---|---|
| `gpt-5.6-luna` | $0.20 | $1.20 |
| `gpt-5.6-terra` | $2.00 | $12.00 |
| `gpt-5.6-sol` | $5.00 | $30.00 |
| `gpt-4o-mini` | $0.15 | $0.60 |
| `gpt-4.1-mini` | $0.40 | $1.60 |
| `text-embedding-3-large` | $0.13 | n/a |
| `text-embedding-3-small` | $0.02 | n/a |

Anthropic models have no rows. If `PLATFORM_LLM_PROVIDER=anthropic`, recorded
`costUsd` is 0 and the recorder writes one warn. Add Claude prices before you
trust the admin endpoint on Anthropic.

## 2. Per-path table

Worst-case USD uses the output `maxTokens` cap on `gpt-5.6-luna` at $1.20/1M,
and the embedding char cap on `text-embedding-3-large` at $0.13/1M treated as
one token per character. Input tokens on chat paths have no hard cap besides
the model context window, so the USD column is output (or embedding) only.

| Path | Trigger | Model | maxTokens / cap | Calls per unit | Worst-case USD | Meter before | Meter after |
|---|---|---|---|---|---|---|---|
| `agent_reply` | Live customer turn | `gpt-5.6-luna` | 1000, up to 10 iterations | up to 10 | $0.012000 | `tenant_token_balance`, Redis daily | those plus `llm_usage_daily` |
| `rag_generate` | Test chat with KB, RAG reply | `gpt-5.6-luna` | 1000 | 1 | $0.001200 | none | `llm_usage_daily` |
| `rag_query_rewrite` | Short anaphoric follow-up | `gpt-5.6-luna` | 150 | 0 or 1 | $0.000180 | none | `llm_usage_daily` |
| `embed_query` | KB search / RAG query | `text-embedding-3-large` | 32,000 chars | 1 per query | $0.004160 | none | `llm_usage_daily` |
| `embed_ingest` | Document index | `text-embedding-3-large` | 32,000 chars per chunk, `RAG_MAX_CHUNKS_PER_DOC` default 1000 | 1 per batch of `RAG_EMBEDDING_BATCH_SIZE` (default 100) | $4.160000 at the chunk cap | none | `llm_usage_daily` |
| `kb_preprocess` | Document ingest (not verbatim) | `gpt-5.6-luna` | 1000 classify, 4000 per transform batch | 1 classify + N transform | $0.001200 + $0.004800 per batch | none | `llm_usage_daily` |
| `doc_ocr` | Scanned PDF or image in chat | `gpt-5.6-luna` | 3500 per page, up to 15 pages | 1 per page | $0.063000 | none | `llm_usage_daily` |
| `localize` | Canned message language mismatch | `gpt-5.6-luna` | 20 then 400 | 1 or 2 | $0.000504 | none | `llm_usage_daily` |
| `insights_judge` | Nightly insights | `gpt-5.6-luna`, `reasoning_effort: low` | 500 | 1 per session | $0.000600 plus reasoning tokens billed as output | none | `llm_usage_daily` |
| `insights_topic_merge` | Canonical topic miss | `gpt-5.6-luna`, `reasoning_effort: low` | 200 | 0 or 1 per new phrase | $0.000240 plus reasoning tokens | none | `llm_usage_daily` |
| `insights_gap_recommendation` | Open Pro+ gaps | `gpt-5.6-luna` | 80 | up to 10 per run | $0.000960 | none | `llm_usage_daily` |
| `insights_digest` | Weekly digest | `gpt-5.6-luna` | 200 | 1 | $0.000240 | none | `llm_usage_daily` |
| `lead_extract` | Lead enrichment sweep | `gpt-5.6-luna`, `reasoning_effort: low` | 700 | 1 per quiet conversation | $0.000840 plus reasoning tokens | none | `llm_usage_daily` |
| `memory_extract` | Customer memory sweep | `gpt-5.6-luna`, `reasoning_effort: low` | 900 | 1 per quiet conversation | $0.001080 plus reasoning tokens | none | `llm_usage_daily` |
| `copilot` | Portal assistant turn | `COPILOT_LLM_MODEL` or `gpt-5.6-luna` | 800, up to 4 iterations | up to 4 | $0.003840 | `tenant_token_balance` | those plus `llm_usage_daily` |
| `test_chat` | Bot / KB test chat without RAG | `gpt-5.6-luna` | 1000 | 1 | $0.001200 | none | `llm_usage_daily` |
| `admin_template_preview` | Super-admin template test chat | `gpt-5.6-luna` | 1000 | 1 | $0.001200 | none | `llm_usage_daily` |
| `health_probe` | Provider health ping | `gpt-5.6-luna` | 16 | 1 | $0.000019 | none | `llm_usage_daily` |

`tenant_token_balance` still drives the 80% warning email and the hard stop.
The Redis daily hash still drives `isOverBudget`. `llm_usage_daily` is
attribution only. It does not bill the tenant.

## 3. Cost per customer conversation

A live turn can spend:

1. `agent_reply` - up to `MAX_ITERATIONS = 10` calls at 1000 output tokens.
   Worst output: **$0.012000**.
2. `embed_query` - one embedding when the bot searches the knowledge base.
   Worst at the 32,000 character cap: **$0.004160**.
3. `rag_query_rewrite` - only for a short follow-up that needs history.
   Worst output: **$0.000180**.
4. `localize` - only when a canned off-hours or escalation string does not
   match the customer language. Worst output: **$0.000504**.

Plan pricing should use `agent_reply` plus `embed_query` as the common case.
Use about **$0.016** worst-case output-plus-embedding per turn before input
tokens. Real input tokens add more. They are not capped by `maxTokens`.

## 4. Cost per ingested document

A text document can spend:

1. `kb_preprocess` classify at 1000 output tokens (**$0.001200**).
2. One transform call per non-prose section at 4000 output tokens
   (**$0.004800** each).
3. `embed_ingest` over chunks, capped at `RAG_MAX_CHUNKS_PER_DOC` (default
   1000). Theoretical max at 32,000 characters per chunk: **$4.160000**.
   Typical chunks are much smaller.

A scanned PDF also spends `doc_ocr` at 3500 output tokens per page, up to
`DOC_OCR_MAX_PAGES` default 15: **$0.063000**. That is the largest
single-document LLM line. Embedding at the chunk cap can exceed it.

Verbatim documents skip `kb_preprocess`. They still embed.

## 5. Cost per insights run

One nightly run can spend:

1. `insights_judge` at 500 output tokens per session. First run is bounded by
   `BACKFILL_CAP = 500` sessions: **$0.300000** output, plus `low` reasoning
   tokens billed as output.
2. `insights_topic_merge` for each new phrase that misses the registry.
3. Up to 10 `insights_gap_recommendation` calls at 80 output tokens:
   **$0.000960**.
4. One `insights_digest` at 200 output tokens: **$0.000240**.

The judge does not consume `dailyLlmCalls`. Spend still lands on
`llm_usage_daily` for that tenant.

## 6. Model migration effect

Four sites moved off hardcoded models onto `gpt-5.6-luna`:

| Previous | Site | Input | Output |
|---|---|---|---|
| `gpt-4o-mini` | KB preprocess, RAG query rewrite, Copilot fallback | **+33%** | **+100%** |
| `gpt-4.1-mini` | Lead extract, memory extract | **-50%** | **-25%** |

`low` reasoning adds output-billed tokens on judge, topic merge, lead extract,
and memory extract. Live customer chat stays at `reasoning_effort: none`.

The goal is one platform model with one switch. The goal is not a smaller bill.
`gpt-4o-mini` paths get more expensive. `gpt-4.1-mini` paths get cheaper.

## 7. Embeddings

`text-embedding-3-large` at $0.13/1M stays. OpenAI has no successor as of
August 2026. `text-embedding-3-small` at $0.02/1M is 6.5 times cheaper. We
reject it for now because it needs a full re-embed and it carries
retrieval-quality risk.

Unexplored non-OpenAI options:

- Cohere `embed-v4`
- Voyage `voyage-3-large`
- Google Gemini Embedding 2

## 8. Unmetered before this change

Only two of about 18 spend paths wrote a durable meter:

- `agent_reply` wrote `tenant_token_balance` and the Redis daily hash.
- `copilot` wrote `tenant_token_balance` only.

These paths recorded nothing:

- `rag_generate`, `rag_query_rewrite`
- `embed_query`, `embed_ingest`
- `kb_preprocess`, `doc_ocr`, `localize`
- `insights_judge`, `insights_topic_merge`, `insights_gap_recommendation`,
  `insights_digest`
- `lead_extract`, `memory_extract`
- `test_chat`, `admin_template_preview`, `health_probe`

`GET /admin/observability/llm-cost` reads `llm_usage_daily`. That table closes
the gap.

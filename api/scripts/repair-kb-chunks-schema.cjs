/* Repair: add the embedding + tsv columns/indexes that CreateKnowledgeTables
 * and AddFullTextSearch were recorded as applying but never created on this
 * (dev-carried-over) DB. Idempotent — safe to re-run. knowledge_chunks has 0
 * rows, so no backfill or lock concern. */
require('dotenv').config();
const { Client } = require('pg');

const STEPS = [
  ['ensure vector extension', `CREATE EXTENSION IF NOT EXISTS vector`],
  ['add embedding column', `ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536)`],
  ['add tsv column', `ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS tsv tsvector`],
  ['index: tenant', `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tenant ON knowledge_chunks("tenantId")`],
  ['index: doc_idx', `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc_idx ON knowledge_chunks("documentId", "chunkIndex")`],
  ['index: embedding (hnsw)', `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_embedding ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`],
  ['index: tsv (gin)', `CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_tsv ON knowledge_chunks USING gin(tsv)`],
];

(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  for (const [label, sql] of STEPS) {
    await c.query(sql);
    console.log(`✓ ${label}`);
  }
  const cols = await c.query(
    `SELECT column_name, udt_name FROM information_schema.columns WHERE table_name='knowledge_chunks' ORDER BY ordinal_position`
  );
  console.log('\nknowledge_chunks columns now:');
  console.table(cols.rows);
  await c.end();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });

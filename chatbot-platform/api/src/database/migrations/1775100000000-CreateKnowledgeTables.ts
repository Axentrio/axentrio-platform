import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateKnowledgeTables1775100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE knowledge_bases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenantId" UUID NOT NULL UNIQUE REFERENCES tenants(id),
        status VARCHAR NOT NULL DEFAULT 'inactive',
        "embeddingModel" VARCHAR NOT NULL DEFAULT 'text-embedding-3-small',
        "chunkSize" INT NOT NULL DEFAULT 1000,
        "chunkOverlap" INT NOT NULL DEFAULT 200,
        "lastIndexedAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`
      CREATE TABLE knowledge_documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "knowledgeBaseId" UUID NOT NULL REFERENCES knowledge_bases(id),
        "tenantId" UUID NOT NULL REFERENCES tenants(id),
        type VARCHAR NOT NULL,
        title VARCHAR NOT NULL,
        "sourceContent" TEXT,
        "storagePath" VARCHAR,
        status VARCHAR NOT NULL DEFAULT 'pending',
        "processingVersion" INT NOT NULL DEFAULT 1,
        "errorMessage" VARCHAR,
        "chunkCount" INT NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`CREATE INDEX idx_knowledge_documents_tenant ON knowledge_documents("tenantId")`);
    await queryRunner.query(`CREATE INDEX idx_knowledge_documents_kb_status ON knowledge_documents("knowledgeBaseId", status)`);

    await queryRunner.query(`
      CREATE TABLE knowledge_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "documentId" UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        "tenantId" UUID NOT NULL REFERENCES tenants(id),
        content TEXT NOT NULL,
        "chunkIndex" INT NOT NULL,
        "charCount" INT NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now()
      )
    `);

    await queryRunner.query(`ALTER TABLE knowledge_chunks ADD COLUMN embedding vector(1536)`);
    await queryRunner.query(`CREATE INDEX idx_knowledge_chunks_tenant ON knowledge_chunks("tenantId")`);
    await queryRunner.query(`CREATE INDEX idx_knowledge_chunks_doc_idx ON knowledge_chunks("documentId", "chunkIndex")`);
    await queryRunner.query(`CREATE INDEX idx_knowledge_chunks_embedding ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS knowledge_chunks`);
    await queryRunner.query(`DROP TABLE IF EXISTS knowledge_documents`);
    await queryRunner.query(`DROP TABLE IF EXISTS knowledge_bases`);
  }
}

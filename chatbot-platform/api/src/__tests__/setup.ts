if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for integration tests');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

import { AppDataSource } from '../database/data-source';
import { beforeAll, afterEach } from 'vitest';

beforeAll(async () => {
  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
    // synchronize(false) creates tables/columns that don't exist yet
    // Global setup already dropped the schema, so this creates everything fresh
    await AppDataSource.synchronize();
  }
});

afterEach(async () => {
  if (!AppDataSource.isInitialized) return;
  const entities = AppDataSource.entityMetadatas;
  for (const entity of entities) {
    const repository = AppDataSource.getRepository(entity.name);
    await repository.query(`TRUNCATE TABLE "${entity.tableName}" CASCADE`);
  }
});

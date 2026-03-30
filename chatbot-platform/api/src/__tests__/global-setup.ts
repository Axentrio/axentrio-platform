/**
 * Vitest Global Setup
 * Runs once before the entire test suite (not per file).
 * Initializes the DB connection and creates the schema.
 */
import { DataSource } from 'typeorm';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set for integration tests');
}

export async function setup() {
  // Create a temporary connection just to set up the schema
  // We use a raw DataSource here to avoid importing app code that has side effects
  const ds = new DataSource({
    type: 'postgres',
    url: TEST_DATABASE_URL,
    synchronize: false,
    logging: false,
  });

  await ds.initialize();

  // Drop and recreate public schema to ensure clean state
  await ds.query('DROP SCHEMA IF EXISTS public CASCADE');
  await ds.query('CREATE SCHEMA public');
  // Pre-create extensions so TypeORM synchronize can handle uuid and vector columns
  await ds.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await ds.query('CREATE EXTENSION IF NOT EXISTS vector');

  await ds.destroy();
}

export async function teardown() {
  // Nothing needed — schema persists for inspection if needed
}

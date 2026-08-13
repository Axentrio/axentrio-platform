import { describe, expect, it } from 'vitest';
import { workerDatabaseName } from '../worker-database';

describe('workerDatabaseName', () => {
  it('scopes the base test database to one numeric worker', () => {
    expect(workerDatabaseName('postgresql://test:test@localhost:5433/chatbot_test', 3))
      .toBe('chatbot_test_3');
  });

  it('rejects identifiers that could widen the reset target', () => {
    expect(() => workerDatabaseName('postgresql://test:test@localhost:5433/chatbot-test', 1))
      .toThrow('Unsafe test worker database name');
    expect(() => workerDatabaseName('postgresql://test:test@localhost:5433/chatbot_test', '1;DROP'))
      .toThrow('Unsafe test worker database name');
  });
});

import { describe, expect, it } from 'vitest';
import {
  testFileDatabaseName,
  testFileDatabaseUrl,
  testTemplateDatabaseName,
} from '../worker-database';

describe('file-process test databases', () => {
  it('uses the unique Vitest worker id, not a recycled pool slot', () => {
    const base = 'postgresql://test:test@localhost:5433/chatbot_test';
    expect(testTemplateDatabaseName(base)).toBe('chatbot_test_template');
    expect(testFileDatabaseName(base, 37)).toBe('chatbot_test_file_37');
  });

  it('rejects identifiers that could widen the reset target', () => {
    expect(() => testFileDatabaseName('postgresql://test:test@localhost:5433/chatbot-test', 1))
      .toThrow('Unsafe test database name');
    expect(() => testFileDatabaseName('postgresql://test:test@localhost:5433/chatbot_test', '1;DROP'))
      .toThrow('Unsafe test worker id');
  });

  it('derives a worker URL without changing the suite base URL', () => {
    const base = 'postgresql://test:test@localhost:5433/chatbot_test';
    expect(testFileDatabaseUrl(base, 2))
      .toBe('postgresql://test:test@localhost:5433/chatbot_test_file_2');
    expect(base).toBe('postgresql://test:test@localhost:5433/chatbot_test');
  });
});

import { describe, it, expect } from 'vitest';
import { renameChatSchema } from '../../schemas/chat.schema';

describe('renameChatSchema', () => {
  it('rejects NUL and newline-only names', () => {
    expect(renameChatSchema.safeParse({ userName: '\0' }).success).toBe(false);
    expect(renameChatSchema.safeParse({ userName: '\n' }).success).toBe(false);
  });

  it('strips control and format chars then keeps a real name', () => {
    const r = renameChatSchema.safeParse({ userName: '  Ada\nLovelace\u200B  ' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.userName).toBe('AdaLovelace');
  });
});

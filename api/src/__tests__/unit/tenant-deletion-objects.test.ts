/**
 * The object half of a deletion.
 *
 * The database row is the only pointer to a storage key, so a purge that stops at
 * the database reports success while the customer's actual documents stay readable
 * in the bucket. These cases pin the two properties that matter: every key is
 * attempted, and one failure does not strand the rest.
 */
import { describe, it, expect, vi } from 'vitest';
import { purgeObjects } from '../../tenants/tenant-deletion.service';

describe('purgeObjects', () => {
  it('attempts every key and reports how many went', async () => {
    const sent: string[] = [];
    const deleted = await purgeObjects(['a', 'b', 'c'], {
      bucket: 'test',
      send: async (key) => {
        sent.push(key);
      },
    });

    expect(sent).toEqual(['a', 'b', 'c']);
    expect(deleted).toBe(3);
  });

  it('keeps going when one key cannot be deleted', async () => {
    const sent: string[] = [];
    const deleted = await purgeObjects(['ok-1', 'gone', 'ok-2'], {
      bucket: 'test',
      send: async (key) => {
        sent.push(key);
        if (key === 'gone') throw new Error('NoSuchKey');
      },
    });

    expect(sent).toEqual(['ok-1', 'gone', 'ok-2']);
    expect(deleted).toBe(2);
  });

  it('does nothing for an empty tenant', async () => {
    const send = vi.fn();
    expect(await purgeObjects([], { bucket: 'test', send })).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

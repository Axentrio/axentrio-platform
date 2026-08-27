import { describe, it, expect } from 'vitest';
import { computeSubjectKey } from '../../memory/subject-key';
import { ERASED_PREFIX } from '../../leads/lead-tombstone';

describe('computeSubjectKey', () => {
  it('uses channel:visitorId for external channels', () => {
    expect(
      computeSubjectKey({ channel: 'whatsapp', visitorId: '32475123456', botId: 'b1' }),
    ).toBe('whatsapp:32475123456');
  });

  it('scopes widget keys to the bot', () => {
    expect(
      computeSubjectKey({ channel: 'widget', visitorId: 'widget-abc', botId: 'b1' }),
    ).toBe('widget:b1:widget-abc');
  });

  it('gives a different widget key when the bot changes', () => {
    const a = computeSubjectKey({ channel: 'widget', visitorId: 'widget-abc', botId: 'b1' });
    const b = computeSubjectKey({ channel: 'widget', visitorId: 'widget-abc', botId: 'b2' });
    expect(a).not.toBe(b);
    expect(b).toBe('widget:b2:widget-abc');
  });

  it('returns null when the widget visitor id is empty', () => {
    expect(computeSubjectKey({ channel: 'widget', visitorId: '', botId: 'b1' })).toBeNull();
  });

  it('returns null for an erasure tombstone visitor id', () => {
    expect(
      computeSubjectKey({ channel: 'whatsapp', visitorId: `${ERASED_PREFIX}lead-1`, botId: 'b1' }),
    ).toBeNull();
  });
});

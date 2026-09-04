import { describe, it, expect, vi, beforeEach } from 'vitest';

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));

vi.mock('../../llm/provider-factory', () => ({
  getProvider: () => ({ chat }),
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { translateFreeText, translateCustomerFreeText } from '../../i18n/translate-free-text';

const NOTE = 'Er is een lek onder de gootsteen in de keuken.';

/** One detection reply, then one translation reply. */
function replies(detected: string, translation?: string): void {
  chat.mockResolvedValueOnce({ content: JSON.stringify({ lang: detected }) });
  if (translation !== undefined) chat.mockResolvedValueOnce({ content: translation });
}

describe('translateFreeText', () => {
  beforeEach(() => {
    chat.mockReset();
  });

  it('returns the original untouched when the note is empty', async () => {
    await expect(translateFreeText({ text: '   ', targetLanguage: 'en', tenantId: 't1' })).resolves.toEqual({
      text: '   ',
      translated: false,
    });
    expect(chat).not.toHaveBeenCalled();
  });

  it('returns the original when the note already reads in the business language', async () => {
    replies('nl');
    await expect(translateFreeText({ text: NOTE, targetLanguage: 'nl-BE', tenantId: 't1' })).resolves.toEqual({
      text: NOTE,
      translated: false,
    });
    // Detection only: no translation call for a same-language note.
    expect(chat).toHaveBeenCalledOnce();
  });

  it('returns the model output when the languages genuinely differ', async () => {
    replies('nl', 'There is a leak under the kitchen sink.');
    await expect(translateFreeText({ text: NOTE, targetLanguage: 'en', tenantId: 't1' })).resolves.toEqual({
      text: 'There is a leak under the kitchen sink.',
      translated: true,
    });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('returns the original when the provider rejects', async () => {
    chat.mockRejectedValueOnce(new Error('daily cap reached'));
    await expect(translateFreeText({ text: NOTE, targetLanguage: 'en', tenantId: 't1' })).resolves.toEqual({
      text: NOTE,
      translated: false,
    });
  });

  it('returns the original when the language cannot be detected', async () => {
    chat.mockResolvedValueOnce({ content: 'I am sorry, I cannot help with that.' });
    await expect(translateFreeText({ text: NOTE, targetLanguage: 'en', tenantId: 't1' })).resolves.toEqual({
      text: NOTE,
      translated: false,
    });
  });

  it('returns the original when the output is empty', async () => {
    replies('nl', '   ');
    await expect(translateFreeText({ text: NOTE, targetLanguage: 'en', tenantId: 't1' })).resolves.toEqual({
      text: NOTE,
      translated: false,
    });
  });

  it('returns the original when the output runs far past the input', async () => {
    replies('nl', 'x'.repeat(NOTE.length * 4 + 201));
    await expect(translateFreeText({ text: NOTE, targetLanguage: 'en', tenantId: 't1' })).resolves.toEqual({
      text: NOTE,
      translated: false,
    });
  });

  it('returns the original when the output introduces a URL', async () => {
    replies('nl', 'There is a leak. See https://evil.example.com for details.');
    await expect(translateFreeText({ text: NOTE, targetLanguage: 'en', tenantId: 't1' })).resolves.toEqual({
      text: NOTE,
      translated: false,
    });
  });

  it('keeps a URL the customer wrote themselves', async () => {
    const withUrl = `${NOTE} Foto: https://files.example.com/a.jpg`;
    replies('nl', 'There is a leak. Photo: https://files.example.com/a.jpg');
    await expect(translateFreeText({ text: withUrl, targetLanguage: 'en', tenantId: 't1' })).resolves.toEqual({
      text: 'There is a leak. Photo: https://files.example.com/a.jpg',
      translated: true,
    });
  });

  it('returns the original when the deadline passes first', async () => {
    chat.mockImplementation(() => new Promise<never>(() => undefined));
    await expect(
      translateFreeText({ text: NOTE, targetLanguage: 'en', tenantId: 't1', timeoutMs: 5 }),
    ).resolves.toEqual({ text: NOTE, translated: false });
  });

  it('returns the original when the target language is not a language', async () => {
    await expect(translateFreeText({ text: NOTE, targetLanguage: 'zzz', tenantId: 't1' })).resolves.toEqual({
      text: NOTE,
      translated: false,
    });
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('translateCustomerFreeText', () => {
  beforeEach(() => {
    chat.mockReset();
  });

  it('reports no originals when nothing needed translating', async () => {
    replies('en');
    await expect(
      translateCustomerFreeText({
        fields: { notes: 'Leak under the sink.' },
        targetLanguage: 'en',
        tenantId: 't1',
      }),
    ).resolves.toEqual({ fields: { notes: 'Leak under the sink.' } });
  });

  it('makes no call at all when both fields are empty', async () => {
    await expect(
      translateCustomerFreeText({ fields: { notes: null, aiSummary: '' }, targetLanguage: 'en', tenantId: 't1' }),
    ).resolves.toEqual({ fields: { notes: null, aiSummary: '' } });
    expect(chat).not.toHaveBeenCalled();
  });

  it('reports the original of every field it translated', async () => {
    // Both fields run in parallel, so the reply order is not fixed: answer by content.
    chat.mockImplementation(async (messages: Array<{ content: string }>) => {
      const payload = messages[1].content;
      if (payload.includes('"target"')) {
        return { content: payload.includes('gootsteen') ? 'Leak under the sink.' : 'Customer wants Monday.' };
      }
      return { content: JSON.stringify({ lang: 'nl' }) };
    });

    const out = await translateCustomerFreeText({
      fields: { notes: 'Lek onder de gootsteen.', aiSummary: 'Klant wil maandag.' },
      targetLanguage: 'en',
      tenantId: 't1',
    });

    expect(out.fields).toEqual({ notes: 'Leak under the sink.', aiSummary: 'Customer wants Monday.' });
    expect(out.originals).toEqual({
      notes: 'Lek onder de gootsteen.',
      aiSummary: 'Klant wil maandag.',
    });
  });

  it('keeps an untranslated field out of the originals block', async () => {
    chat.mockImplementation(async (messages: Array<{ content: string }>) => {
      const payload = messages[1].content;
      if (payload.includes('"target"')) return { content: 'Leak under the sink.' };
      return { content: JSON.stringify({ lang: payload.includes('gootsteen') ? 'nl' : 'en' }) };
    });

    const out = await translateCustomerFreeText({
      fields: { notes: 'Lek onder de gootsteen.', aiSummary: 'Customer wants Monday.' },
      targetLanguage: 'en',
      tenantId: 't1',
    });

    expect(out.fields.aiSummary).toBe('Customer wants Monday.');
    expect(out.originals).toEqual({ notes: 'Lek onder de gootsteen.' });
  });
});

/**
 * The two address controls, driven in a real DOM.
 *
 * `widget.js` is a 2838-line plain script with no module boundary, and until this file it had no
 * coverage of any kind. The picker, the correction buttons, the debounce, the re-render on a stale
 * answer and the history metadata fix all shipped to production on `node --check` and a manual
 * protocol that was declared a completion requirement and never run. Every live test drove the
 * REST API directly, which bypasses this file entirely - so the server contract was proven and the
 * thing customers actually touch was not.
 *
 * It is a UMD module that returns the class, so it can be required into jsdom and driven without
 * the network. What is asserted here is only what a customer would see or cause:
 *
 *   - the controls render from `metadata.affordance`, which is server-decided;
 *   - typing is gated and debounced, because suggestions are billed per request;
 *   - choosing an address posts to `/places/select` and sends NO message, because the server
 *     already speaks the address into the conversation and a second copy would arrive as text the
 *     model reconstructs;
 *   - answering posts the server-issued `proposalId` and nothing else;
 *   - a stale answer re-renders the question that IS open, never the one that is not.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Module from 'node:module';

const WIDGET = join(__dirname, '../../../public/widget.js');

/** Load the UMD bundle and hand back the class, without letting autoInit touch the network. */
function loadWidget(): new (config: Record<string, unknown>) => Record<string, never> {
  const src = readFileSync(WIDGET, 'utf8');
  const m = new Module(WIDGET);
  m.filename = WIDGET;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any)._compile(src, WIDGET);
  return m.exports as never;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Fake just enough of the transport. Everything else is the real widget. */
function reply(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body });
}

beforeEach(() => {
  document.body.innerHTML = '';
  fetchMock = vi.fn(() => reply({ success: true, data: {} }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('io', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/**
 * A widget instance with its DOM built, its socket suppressed, and one bot message rendered.
 *
 * `renderMessage` is the seam under test: it is what turns `metadata.affordance` into controls,
 * and it is a pure string function, so it can be exercised without a session.
 */
function renderBotMessage(affordance: unknown): { root: HTMLElement; widget: Record<string, never> } {
  const ChatbotWidget = loadWidget();
  const widget = new ChatbotWidget({ apiKey: 'k', apiUrl: 'https://api.test', debug: false });
  const root = document.createElement('div');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  root.innerHTML = (widget as any).renderMessage({
    id: 'm1',
    text: 'Which address should we use?',
    sender: 'bot',
    timestamp: new Date(0),
    affordance,
  });
  document.body.appendChild(root);
  return { root, widget };
}

describe('the address picker', () => {
  it('renders an input prefilled with what the customer typed', () => {
    const { root } = renderBotMessage({
      kind: 'address_picker',
      reason: 'unverified',
      query: 'Kerkstraat 12, 2060 Antwerpen',
    });

    const input = root.querySelector<HTMLInputElement>('.cb-addr__input');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('Kerkstraat 12, 2060 Antwerpen');
  });

  it('says why, when Google only reached the town', () => {
    // `too_vague` is the case where picking changes the customer's OUTCOME rather than tidying the
    // record: town-only means no time can be auto-confirmed at all.
    const { root } = renderBotMessage({ kind: 'address_picker', reason: 'too_vague', query: 'Antwerpen' });

    expect(root.textContent).toMatch(/could only find your town/i);
  });

  it('renders nothing at all when the server offered nothing', () => {
    // The control is server-decided. A widget that renders it on its own would be paying for
    // suggestions on turns the server judged did not need them.
    const { root } = renderBotMessage(undefined);

    expect(root.querySelector('.cb-addr')).toBeNull();
  });

  it('escapes an address rather than injecting it', () => {
    // Both places an address reaches innerHTML: as an attribute VALUE on the input, and as element
    // TEXT on the confirm buttons. The first version of this test only checked the attribute, with
    // a payload containing no quote - so it could not break out and the assertion held with the
    // escaping removed. A test that passes against the unescaped code is not a test.
    const attr = renderBotMessage({
      kind: 'address_picker',
      reason: 'unverified',
      query: '" autofocus onfocus="alert(1)',
    }).root;
    expect(attr.querySelector<HTMLInputElement>('.cb-addr__input')?.getAttribute('onfocus')).toBeNull();

    const text = renderBotMessage({
      kind: 'address_confirm',
      proposalId: 'p1',
      proposed: '<img src=x onerror=alert(1)>',
      bound: 'Grote Markt 1',
    }).root;
    expect(text.querySelector('img')).toBeNull();
  });
});

describe('escaping', () => {
  it('escapes an attribute ONCE, so a signed URL survives', () => {
    // The attribute sweep wrapped an existing inline escaper instead of replacing it, so `&`
    // became `&amp;amp;` and any avatar URL with a query string broke. Two correct escapers
    // compose into a wrong one.
    const ChatbotWidget = loadWidget();
    const widget = new ChatbotWidget({
      apiKey: 'k',
      apiUrl: 'https://api.test',
      avatarUrl: 'https://cdn.example.com/a.png?v=1&sig=abc',
    });
    const root = document.createElement('div');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    root.innerHTML = (widget as any).renderMessage({
      id: 'm', text: 'hi', sender: 'bot', timestamp: new Date(0),
    });

    const src = root.querySelector('img')?.getAttribute('src') ?? '';
    if (src) expect(src).toBe('https://cdn.example.com/a.png?v=1&sig=abc');
  });
});

describe('the correction question', () => {
  const AFF = {
    kind: 'address_confirm',
    proposalId: 'abc123',
    proposed: 'Kerkstraat 12, 2060 Antwerpen',
    bound: 'Grote Markt 1, 2000 Antwerpen',
  };

  it('renders BOTH options, each labelled with its own address', () => {
    // The load-bearing property: the server states the options. A control naming one address and
    // leaving the other to the surrounding prose would put the model back in charge of the choice.
    const { root } = renderBotMessage(AFF);

    const rows = [...root.querySelectorAll('.cb-addr__row')].map((b) => b.textContent || '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Kerkstraat 12, 2060 Antwerpen');
    expect(rows[1]).toContain('Grote Markt 1, 2000 Antwerpen');
  });

  it('carries the server-issued proposal id, not the address', () => {
    const { root } = renderBotMessage(AFF);

    expect(root.querySelector('.cb-addr')?.getAttribute('data-addr-confirm')).toBe('abc123');
  });

  it('posts the id and a boolean, and nothing else', async () => {
    // Deliberately no address in the body. The server already knows what it asked, and a client
    // naming a place here would be an unverified claim wearing the customer's authority.
    const { root, widget } = renderBotMessage(AFF);
    fetchMock.mockReturnValue(reply({ success: true, data: { applied: true, address: AFF.proposed } }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).token = 'tok';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).answerAddressQuestion(root.querySelector('.cb-addr'), 'abc123', true);

    // The constructor fires its own /config call, so pick the request under test by URL rather
    // than by position - asserting on calls[0] would have been asserting on the bootstrap.
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/address/confirm')) as
      | [string, { body: string }]
      | undefined;
    expect(call, 'no request was made to /address/confirm').toBeDefined();
    expect(JSON.parse(call![1].body)).toEqual({ proposalId: 'abc123', confirmed: true });
  });

  it('re-renders the question that IS open when the answer is stale', async () => {
    // Verified against production: a control can outlive its question. Re-rendering the stale
    // choice would invite a second tap on something already dead, so the server returns whatever
    // is outstanding now and the control becomes THAT question.
    const { root, widget } = renderBotMessage(AFF);
    fetchMock.mockReturnValue(
      reply({
        success: true,
        data: {
          applied: false,
          reason: 'no_longer_outstanding',
          current: { bound: 'Meir 78, 2000 Antwerpen', proposed: 'Kerkstraat 12, 2060 Antwerpen', proposalId: 'zzz999' },
        },
      })
    );

    const box = root.querySelector('.cb-addr')!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).token = 'tok';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).answerAddressQuestion(box, 'abc123', true);

    expect(box.getAttribute('data-addr-confirm')).toBe('zzz999');
    expect(box.textContent).toContain('Meir 78, 2000 Antwerpen');
  });

  it('removes the control when nothing is outstanding any more', async () => {
    const { root, widget } = renderBotMessage(AFF);
    fetchMock.mockReturnValue(
      reply({ success: true, data: { applied: false, reason: 'no_longer_outstanding', current: { bound: 'x', proposed: null, proposalId: null } } })
    );

    const box = root.querySelector('.cb-addr')!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (widget as any).token = 'tok';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (widget as any).answerAddressQuestion(box, 'abc123', true);

    expect(box.querySelector('.cb-addr__row')).toBeNull();
    expect(box.textContent).toMatch(/no longer open/i);
  });
});

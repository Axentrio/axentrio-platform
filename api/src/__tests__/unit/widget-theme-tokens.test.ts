/**
 * Brand colour from /widget/config must paint --cb-primary.
 *
 * The portal saves primaryColor on bot.settings.theme. The public config
 * payload carries it on appearance.primaryColor. The widget must apply that
 * value instead of DEFAULT_CONFIG (#4F46E5).
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Module from 'node:module';

const WIDGET = join(__dirname, '../../../public/widget.js');

type WidgetHost = {
  host: HTMLElement;
};

type CompilableModule = Module & {
  _compile: (content: string, filename: string) => void;
};

function loadWidget(): new (config: Record<string, unknown>) => WidgetHost {
  const src = readFileSync(WIDGET, 'utf8');
  const m = new Module(WIDGET) as CompilableModule;
  m.filename = WIDGET;
  m._compile(src, WIDGET);
  return m.exports as new (config: Record<string, unknown>) => WidgetHost;
}

function reply(body: unknown, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body });
}

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubGlobal('fetch', vi.fn(() => reply({ success: true, data: {} })));
  vi.stubGlobal('io', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function mountWidget(appearance: Record<string, unknown>): Promise<WidgetHost> {
  const fetchMock = vi.fn(() =>
    reply({
      success: true,
      data: { appearance },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const ChatbotWidget = loadWidget();
  const widget = new ChatbotWidget({ apiKey: 'k', apiUrl: 'https://api.test', debug: false });
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
  });
  await vi.waitFor(() => {
    expect(widget.host).toBeTruthy();
  });
  // Let _loadAppearanceConfig finish after fetch resolves.
  await Promise.resolve();
  await Promise.resolve();
  return widget;
}

describe('widget.js brand colour', () => {
  it('applies a supplied appearance.primaryColor instead of the default', async () => {
    const widget = await mountWidget({
      primaryColor: '#c41e3a',
      avatarUrl: null,
      launcherPosition: 'bottom-right',
      launcherLabel: null,
    });
    await vi.waitFor(() => {
      expect(widget.host.style.getPropertyValue('--cb-primary')).toBe('#c41e3a');
    });
  });

  it('keeps the editorial default when no colour is saved', async () => {
    const widget = await mountWidget({
      primaryColor: null,
      avatarUrl: null,
      launcherPosition: 'bottom-right',
      launcherLabel: null,
    });
    await vi.waitFor(() => {
      expect(widget.host.style.getPropertyValue('--cb-primary')).toBe('#4F46E5');
    });
  });
});

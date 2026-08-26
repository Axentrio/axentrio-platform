import { describe, expect, it, vi, beforeEach } from 'vitest';

const axiosGet = vi.fn();
const axiosPost = vi.fn();

vi.mock('axios', () => ({
  default: { get: (...args: unknown[]) => axiosGet(...args), post: (...args: unknown[]) => axiosPost(...args) },
}));

vi.mock('../../config/environment', () => ({
  config: {
    meta: { appId: '1548698999932589', appSecret: 'app-secret' },
    whatsapp: {
      verifyToken: 'verify',
      appSecret: 'app-secret',
      embeddedSignup: { enabled: true, configId: 'config-1' },
    },
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const setupWhatsAppConnection = vi.fn();
vi.mock('../../channels/whatsapp/setup.service', () => ({
  setupWhatsAppConnection: (...args: unknown[]) => setupWhatsAppConnection(...args),
}));

import {
  exchangeEmbeddedSignupCode,
  completeWhatsAppEmbeddedSignup,
  isWhatsAppEmbeddedSignupReady,
} from '../../channels/whatsapp/embedded-signup.service';

describe('WhatsApp Embedded Signup', () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
    setupWhatsAppConnection.mockReset();
  });

  it('is ready when enabled with a config id and app credentials', () => {
    expect(isWhatsAppEmbeddedSignupReady()).toBe(true);
  });

  it('exchanges the code without sending redirect_uri', async () => {
    axiosGet.mockResolvedValue({ data: { access_token: 'EAAG_biz' } });
    await expect(exchangeEmbeddedSignupCode('code-30s')).resolves.toBe('EAAG_biz');
    expect(axiosGet).toHaveBeenCalledTimes(1);
    const params = axiosGet.mock.calls[0][1].params as Record<string, string>;
    expect(params).toEqual({
      client_id: '1548698999932589',
      client_secret: 'app-secret',
      code: 'code-30s',
    });
    expect(params.redirect_uri).toBeUndefined();
  });

  it('registers the phone then persists via setupWhatsAppConnection', async () => {
    axiosGet.mockResolvedValue({ data: { access_token: 'EAAG_biz' } });
    axiosPost.mockResolvedValue({ data: { success: true } });
    setupWhatsAppConnection.mockResolvedValue({ id: 'conn-1' });

    await completeWhatsAppEmbeddedSignup('tenant-1', {
      code: 'code-30s',
      phoneNumberId: '123',
      wabaId: 'waba-9',
    });

    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/123\/register$/),
      expect.objectContaining({ messaging_product: 'whatsapp', pin: expect.stringMatching(/^\d{6}$/) }),
      expect.objectContaining({ headers: { Authorization: 'Bearer EAAG_biz' } }),
    );
    expect(setupWhatsAppConnection).toHaveBeenCalledWith('tenant-1', {
      phoneNumberId: '123',
      accessToken: 'EAAG_biz',
      wabaId: 'waba-9',
    });
  });
});

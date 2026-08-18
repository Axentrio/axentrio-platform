import { describe, it, expect } from 'vitest';
import { resolveQuotedAddress } from '../../account/quoted-address';

const ACCOUNT = {
  street: 'Edingensesteenweg 196',
  postalCode: '1500',
  city: 'Halle',
  country: 'BE',
};

const BOT = {
  street: 'Grote Markt 1',
  postalCode: '9300',
  city: 'Aalst',
  country: 'BE',
};

describe('resolveQuotedAddress', () => {
  it('returns null when the per-bot field is off', () => {
    expect(
      resolveQuotedAddress({
        botAddressEnabled: false,
        botAddress: BOT,
        accountAddress: ACCOUNT,
      }),
    ).toBeNull();
  });

  it('uses the per-bot address when the field is on and filled', () => {
    expect(
      resolveQuotedAddress({
        botAddressEnabled: true,
        botAddress: BOT,
        accountAddress: ACCOUNT,
      }),
    ).toBe('Grote Markt 1, 9300 Aalst, BE');
  });

  it('falls back to the account address when the field is on but blank', () => {
    expect(
      resolveQuotedAddress({
        botAddressEnabled: true,
        botAddress: { street: '', postalCode: '', city: '', country: '' },
        accountAddress: ACCOUNT,
      }),
    ).toBe('Edingensesteenweg 196, 1500 Halle, BE');
  });

  it('returns null when neither address is usable', () => {
    expect(
      resolveQuotedAddress({
        botAddressEnabled: false,
        botAddress: null,
        accountAddress: null,
      }),
    ).toBeNull();
  });
});

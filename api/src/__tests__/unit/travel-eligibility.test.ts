/**
 * The four gates in front of the paid dependency, and the ORDER they run in.
 *
 * The order is asserted directly rather than inferred from the verdict, because a
 * refactor that reorders them stays green on verdicts alone while quietly making every
 * request on a platform with no Maps key resolve an entitlement it will not use.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { travelConfig, getEntitlements, bsFindOne, bsSave, bsUpdate, itineraryKeyIsShared } = vi.hoisted(() => ({
  travelConfig: { googleMapsApiKey: 'key-1' as string | undefined },
  getEntitlements: vi.fn(),
  bsFindOne: vi.fn(),
  bsSave: vi.fn(),
  bsUpdate: vi.fn(),
  itineraryKeyIsShared: vi.fn(),
}));

vi.mock('../../config/environment', () => ({ config: { travel: travelConfig } }));
vi.mock('../../billing/entitlements', () => ({ getEntitlements }));
vi.mock('../../scheduler/itinerary-key', () => ({ itineraryKeyIsShared }));
vi.mock('../../database/data-source', () => ({
  AppDataSource: { getRepository: () => ({ findOne: bsFindOne, save: bsSave, update: bsUpdate }) },
}));
vi.mock('../../utils/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  resolveTravelEligibility,
  warnIfTravelItineraryNowShared,
} from '../../booking/travel/travel-eligibility';
import { logger } from '../../utils/logger';

const ARGS = { tenantId: 'ten-1', botId: 'bot-1', itineraryKey: 'gcal:owner@acme.com' };

describe('resolveTravelEligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    travelConfig.googleMapsApiKey = 'key-1';
    getEntitlements.mockResolvedValue({ features: { travelTime: true } });
    bsFindOne.mockResolvedValue({ travelTimeEnabled: true, travelSlackMin: 10, travelStartFromBase: true });
    itineraryKeyIsShared.mockResolvedValue(false);
  });

  it('is active when all four gates pass, carrying the settings the gate will need', async () => {
    expect(await resolveTravelEligibility(ARGS)).toEqual({
      active: true,
      // Carried so that anything able to spend a billable element can take this value as its
      // argument instead of a bare tenant id, which is what makes "only ever for an entitled
      // Tenant on an enabled Agent" a rule the compiler enforces.
      tenantId: 'ten-1',
      itineraryKey: 'gcal:owner@acme.com',
      slackMin: 10,
      startFromBase: true,
    });
  });

  it('stops at the missing API key WITHOUT consulting the entitlement resolver', async () => {
    travelConfig.googleMapsApiKey = undefined;
    expect(await resolveTravelEligibility(ARGS)).toEqual({ active: false, reason: 'no_api_key' });
    expect(getEntitlements).not.toHaveBeenCalled();
    expect(bsFindOne).not.toHaveBeenCalled();
    expect(itineraryKeyIsShared).not.toHaveBeenCalled();
  });

  it('stops at an unentitled tenant without reading the bot settings', async () => {
    getEntitlements.mockResolvedValue({ features: { travelTime: false } });
    expect(await resolveTravelEligibility(ARGS)).toEqual({ active: false, reason: 'not_entitled' });
    expect(bsFindOne).not.toHaveBeenCalled();
    expect(itineraryKeyIsShared).not.toHaveBeenCalled();
  });

  it('fails closed when entitlements cannot be resolved', async () => {
    getEntitlements.mockRejectedValue(new Error('tenant not found'));
    expect(await resolveTravelEligibility(ARGS)).toEqual({ active: false, reason: 'not_entitled' });
  });

  it('stops at the bot toggle without querying for sibling bots', async () => {
    bsFindOne.mockResolvedValue({ travelTimeEnabled: false });
    expect(await resolveTravelEligibility(ARGS)).toEqual({ active: false, reason: 'bot_disabled' });
    expect(itineraryKeyIsShared).not.toHaveBeenCalled();
  });

  it('reads a bot with no settings row as off', async () => {
    bsFindOne.mockResolvedValue(null);
    expect(await resolveTravelEligibility(ARGS)).toEqual({ active: false, reason: 'bot_disabled' });
  });

  it('goes inert when a second bot shares the diary, even with the toggle on', async () => {
    // A rekey can create this state long after travel was legitimately enabled, which is
    // why the check is here and not only on the enable path.
    itineraryKeyIsShared.mockResolvedValue(true);
    expect(await resolveTravelEligibility(ARGS)).toEqual({ active: false, reason: 'shared_itinerary' });
    expect(itineraryKeyIsShared).toHaveBeenCalledWith('ten-1', 'bot-1', 'gcal:owner@acme.com');
  });

  it('defaults slack to zero and never lets a negative one tighten the gap', async () => {
    bsFindOne.mockResolvedValue({ travelTimeEnabled: true, travelSlackMin: -30 });
    expect(await resolveTravelEligibility(ARGS)).toMatchObject({ slackMin: 0, startFromBase: false });
  });
});

/**
 * The other half of gate 4: connecting a calendar can create the shared state months after
 * the owner legitimately switched travel on, and the enable-time refusal cannot see that
 * coming.
 */
describe('warnIfTravelItineraryNowShared', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bsFindOne.mockResolvedValue({ tenantId: 'ten-1', travelTimeEnabled: true });
    itineraryKeyIsShared.mockResolvedValue(true);
  });

  it('warns when a bot with travel on lands on a diary someone else already holds', async () => {
    await warnIfTravelItineraryNowShared('bot-1', 'gcal:shared@acme.com');
    expect(itineraryKeyIsShared).toHaveBeenCalledWith('ten-1', 'bot-1', 'gcal:shared@acme.com');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('TRAVEL_SHARED_ITINERARY'),
      expect.objectContaining({ botId: 'bot-1', itineraryKey: 'gcal:shared@acme.com' })
    );
  });

  it('costs one read for a bot with travel off — which is every bot by default', async () => {
    bsFindOne.mockResolvedValue({ tenantId: 'ten-1', travelTimeEnabled: false });
    await warnIfTravelItineraryNowShared('bot-1', 'gcal:shared@acme.com');
    expect(itineraryKeyIsShared).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says nothing when the new diary is the bot’s alone', async () => {
    itineraryKeyIsShared.mockResolvedValue(false);
    await warnIfTravelItineraryNowShared('bot-1', 'gcal:owner@acme.com');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does not switch the owner’s setting off — it only reads', async () => {
    // Rekey is best-effort and its callers swallow failures, so a write here would
    // sometimes not happen and the stored setting would then disagree with what the owner
    // last chose. Gate 4 already makes the feature inert, so nothing unsafe is left running.
    await warnIfTravelItineraryNowShared('bot-1', 'gcal:shared@acme.com');
    expect(bsSave).not.toHaveBeenCalled();
    expect(bsUpdate).not.toHaveBeenCalled();
  });

  it('never throws — a rekey must not fail because a warning could not be produced', async () => {
    bsFindOne.mockRejectedValue(new Error('db down'));
    await expect(warnIfTravelItineraryNowShared('bot-1', 'gcal:x')).resolves.toBeUndefined();
  });
});

/**
 * The address binding's invariants, asserted against a real Postgres.
 *
 * These are here rather than in a unit test on purpose. The invariant this file cares about is a
 * CHECK constraint, and a constraint is not a property of the code - it is a property of the
 * schema. A mock would agree with whatever the code did.
 *
 * The test schema is built by `synchronize()` from entity metadata, NOT by running migrations, so
 * these tests also prove the thing that class of bug turns on: that the constraint is declared on
 * the entity and therefore exists here at all. A constraint written only into the migration would
 * pass every test in this repository and hold in production alone.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AppDataSource } from '../../database/data-source';
import { AddressBinding } from '../../database/entities/AddressBinding';

const repo = () => AppDataSource.getRepository(AddressBinding);

describe('the address binding schema', () => {
  let sessionId: string;
  beforeEach(() => {
    sessionId = randomUUID();
  });

  it('stores a PICKED address with the identity the customer chose', async () => {
    await repo().save(
      repo().create({ sessionId, address: 'Meir 78, 2000 Antwerpen', placeId: 'ChIJ_meir', source: 'picked' })
    );
    const row = await repo().findOneByOrFail({ sessionId });
    expect(row.placeId).toBe('ChIJ_meir');
    expect(row.version).toBe(0);
  });

  it('stores a CONFIRMED address with no identity, because nothing was geocoded', async () => {
    await repo().save(
      repo().create({ sessionId, address: 'Kerkstraat 12, 2060 Antwerpen', placeId: null, source: 'confirmed' })
    );
    const row = await repo().findOneByOrFail({ sessionId });
    expect(row.source).toBe('confirmed');
    expect(row.placeId).toBeNull();
  });

  it('stores a CLEARED binding whose question is still answerable', async () => {
    // The state the whole design turns on: a booking took the address and consumed the question,
    // the question survives, and answering it governs the next booking rather than the one made.
    await repo().save(
      repo().create({
        sessionId,
        address: null,
        placeId: null,
        source: null,
        pending: { proposalId: 'p1', formattedAddress: 'Bist 1, 2610 Wilrijk', consumedByBooking: 'bk-1' },
      })
    );
    const row = await repo().findOneByOrFail({ sessionId });
    expect(row.address).toBeNull();
    expect(row.pending?.consumedByBooking).toBe('bk-1');
  });

  describe('the combinations the database refuses', () => {
    // Each of these is a real mistake with a real consequence, not a theoretical one.
    const rejected: Array<[string, Partial<AddressBinding>, string]> = [
      [
        'a picked address with no identity',
        { address: 'Meir 78', placeId: null, source: 'picked' },
        'this is exactly what a careless promote produces: it claims the customer chose the place while ' +
          'carrying nothing to prove it, and placement silently downgrades to geocoding the words again',
      ],
      [
        'a confirmed address carrying an identity',
        { address: 'Meir 78', placeId: 'ChIJ_meir', source: 'confirmed' },
        'a confirmation resolves nothing, so an identity here was invented somewhere',
      ],
      [
        'an address with no source',
        { address: 'Meir 78', placeId: null, source: null },
        'nothing downstream could tell whether the customer picked it or merely said it',
      ],
      [
        'a cleared binding still holding an address',
        { address: null, placeId: 'ChIJ_meir', source: 'picked' },
        'a half-cleared binding is the one a second booking would inherit',
      ],
    ];

    it.each(rejected)('refuses %s', async (_name, patch) => {
      await expect(repo().save(repo().create({ sessionId, ...patch }))).rejects.toThrow();
    });
  });
});

describe('the empty string is not an address', () => {
  // `'' IS NOT NULL` is true, so the first constraint let `address = ''` be `confirmed` and
  // `place_id = ''` satisfy `picked` - while `addressToken` collapses a blank address to the same
  // constant as no address. The row and the token would have disagreed about what it means.
  it.each([
    ['a blank address claiming to be confirmed', { address: '', placeId: null, source: 'confirmed' as const }],
    ['a blank place id satisfying picked', { address: 'Meir 78', placeId: '', source: 'picked' as const }],
  ])('refuses %s', async (_n, patch) => {
    const { randomUUID } = await import('node:crypto');
    const { AppDataSource } = await import('../../database/data-source');
    const { AddressBinding } = await import('../../database/entities/AddressBinding');
    const r = AppDataSource.getRepository(AddressBinding);
    await expect(r.save(r.create({ sessionId: randomUUID(), ...patch }))).rejects.toThrow();
  });
});

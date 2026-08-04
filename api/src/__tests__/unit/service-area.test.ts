import { describe, it, expect } from 'vitest';
import {
  matchServiceArea,
  describeServiceArea,
  MAX_SERVICE_AREA_ENTRIES,
  type ServiceAreaEntry,
} from '../../contracts/service-area';
import {
  searchPlaces,
  placesFromAddress,
  municipalityLabel,
  provinceLabel,
  PROVINCES,
  MUNICIPALITIES,
} from '../../contracts/belgium-geo';
import { buildServiceAreaSection } from '../../modules/booking.module';
import { serviceAreaSchema } from '../../schemas/scheduler.schema';
import { composeSystemPrompt } from '../../llm/compose-system-prompt';
import { PLACEHOLDER_CATALOG } from '../../contracts/prompt-placeholders';

/** Oost-Vlaanderen, the province in the mocked design. */
const OOST = '40000';
const province = (id: string, label = 'Oost-Vlaanderen'): ServiceAreaEntry => ({ kind: 'province', id, label });
const municipality = (id: string, label: string): ServiceAreaEntry => ({ kind: 'municipality', id, label });
const manual = (label: string): ServiceAreaEntry => ({ kind: 'manual', label });

/** Look a municipality up the way the portal would, so ids in tests are real. */
const nisOf = (name: string): string => {
  const found = MUNICIPALITIES.find((m) => [m.nl, m.fr, m.de].includes(name));
  if (!found) throw new Error(`no municipality named ${name}`);
  return found.nis;
};

describe('belgium-geo dataset', () => {
  it('covers the whole country at the resolution service areas need', () => {
    expect(PROVINCES).toHaveLength(11); // 10 provinces + Brussels-Capital
    expect(MUNICIPALITIES.length).toBeGreaterThan(550);
    const postcodes = new Set(MUNICIPALITIES.flatMap((m) => m.pc));
    expect(postcodes.size).toBeGreaterThan(1100);
  });

  it('labels each place in its own region language', () => {
    expect(provinceLabel(PROVINCES.find((p) => p.code === OOST)!)).toBe('Oost-Vlaanderen');
    // Walloon provinces read French, not the Dutch exonym "Luik".
    expect(provinceLabel(PROVINCES.find((p) => p.code === '60000')!)).toBe('Liège');
    // Brussels is officially bilingual, so it carries both.
    expect(provinceLabel(PROVINCES.find((p) => p.code === 'BRU')!)).toContain('/');
  });
});

describe('searchPlaces', () => {
  it('finds a province and ranks it above municipalities matching as well', () => {
    const out = searchPlaces('oost');
    expect(out[0]).toMatchObject({ kind: 'province', label: 'Oost-Vlaanderen' });
  });

  it('finds a city by partial name, with its province as context', () => {
    const [first] = searchPlaces('sint-nik');
    expect(first).toMatchObject({ kind: 'municipality', label: 'Sint-Niklaas' });
    expect(first.context).toBe('Oost-Vlaanderen, België');
  });

  it('finds a municipality from a bare postal code', () => {
    expect(searchPlaces('9310')[0]).toMatchObject({ kind: 'municipality', label: 'Aalst' });
  });

  it('matches across languages and accents', () => {
    expect(searchPlaces('anvers').some((s) => s.label === 'Antwerpen')).toBe(true);
    expect(searchPlaces('liege').some((s) => s.label === 'Liège')).toBe(true);
  });

  it('returns nothing for a blank or one-character query', () => {
    expect(searchPlaces('')).toEqual([]);
    expect(searchPlaces('   ')).toEqual([]);
  });
});

describe('placesFromAddress', () => {
  it('reads the postcode out of a full street address', () => {
    // The exact address from the design mock.
    const out = placesFromAddress('Grote Baan 220, 9310 Herdersem, België');
    expect(out.via).toBe('postcode');
    expect(out.municipalities.map(municipalityLabel)).toContain('Aalst');
  });

  it('falls back to a town name when no postcode is present', () => {
    const out = placesFromAddress('ik woon in Gent');
    expect(out.via).toBe('name');
    expect(out.municipalities.map(municipalityLabel)).toContain('Gent');
  });

  it('resolves a Dutch exonym to the same municipality as its French name', () => {
    expect(placesFromAddress('Bergen').municipalities[0].nis).toBe(placesFromAddress('Mons').municipalities[0].nis);
  });

  it('reports nothing rather than guessing on an unplaceable address', () => {
    expect(placesFromAddress('the house behind the church').via).toBeNull();
    expect(placesFromAddress('').via).toBeNull();
  });

  it('does not mistake a street containing a town name for that town', () => {
    // "Gentstraat" is one word — whole-word matching must not read "Gent" inside it.
    const out = placesFromAddress('Gentstraat 4');
    expect(out.municipalities.map(municipalityLabel)).not.toContain('Gent');
  });
});

describe('matchServiceArea', () => {
  it('is inside when the address falls in a listed province', () => {
    expect(matchServiceArea('Grote Baan 220, 9310 Herdersem', [province(OOST)])).toBe('inside');
  });

  it('is inside when the address is the listed municipality itself', () => {
    expect(matchServiceArea('Grote Markt 1, 9100 Sint-Niklaas', [municipality(nisOf('Sint-Niklaas'), 'Sint-Niklaas')])).toBe(
      'inside',
    );
  });

  it('is outside when the address resolves somewhere not listed', () => {
    expect(matchServiceArea('Rue des Guillemins 12, 4000 Liège', [province(OOST)])).toBe('outside');
  });

  it('is unknown when no area is configured — the pre-feature behaviour', () => {
    expect(matchServiceArea('Rue des Guillemins 12, 4000 Liège', [])).toBe('unknown');
    expect(matchServiceArea('Rue des Guillemins 12, 4000 Liège', null)).toBe('unknown');
  });

  it('is unknown when there is no address, or one it cannot place', () => {
    expect(matchServiceArea(null, [province(OOST)])).toBe('unknown');
    expect(matchServiceArea('   ', [province(OOST)])).toBe('unknown');
    expect(matchServiceArea('the house behind the church', [province(OOST)])).toBe('unknown');
  });

  it('reads a manual entry the parser understands as a real rule', () => {
    expect(matchServiceArea('9100 Sint-Niklaas', [manual('Sint-Niklaas')])).toBe('inside');
    expect(matchServiceArea('4000 Liège', [manual('Sint-Niklaas')])).toBe('outside');
  });

  it('treats a pasted street address as coverage of the place it names', () => {
    // The third chip in the design mock. It should ADD Aalst, not blur the whole area.
    const area = [municipality(nisOf('Sint-Niklaas'), 'Sint-Niklaas'), manual('Grote Baan 220, 9310 Herdersem')];
    expect(matchServiceArea('9310 Herdersem', area)).toBe('inside');
    expect(matchServiceArea('4000 Liège', area)).toBe('outside');
  });

  it('never NARROWS a radius entry to the town it names', () => {
    // "30 km rond Aalst" contains "Aalst", but reducing it to Aalst-only would refuse
    // the neighbouring customers the owner explicitly said yes to.
    expect(matchServiceArea('9300 Aalst', [manual('30 km rond Aalst')])).toBe('unknown');
    expect(matchServiceArea('9100 Sint-Niklaas', [manual('30 km rond Aalst')])).toBe('unknown');
    expect(matchServiceArea('4000 Liège', [manual('within 25 km of Ghent')])).toBe('unknown');
  });

  it('FAILS OPEN when any listed entry cannot be understood', () => {
    // "30 km around Aalst" is a note, not a rule — so a non-match must not become a refusal.
    expect(matchServiceArea('4000 Liège', [province(OOST), manual('30 km rond Aalst')])).toBe('unknown');
    // …but a genuine match still wins outright.
    expect(matchServiceArea('9310 Herdersem', [province(OOST), manual('30 km rond Aalst')])).toBe('inside');
  });

  it('fails open on an id the geo table no longer knows', () => {
    expect(matchServiceArea('4000 Liège', [province('99999', 'Somewhere')])).toBe('unknown');
  });
});

describe('describeServiceArea', () => {
  it('lists the labels as written by the owner', () => {
    expect(describeServiceArea([province(OOST), municipality(nisOf('Sint-Niklaas'), 'Sint-Niklaas')])).toBe(
      'Oost-Vlaanderen, Sint-Niklaas',
    );
  });

  it('is empty for an empty area, so nothing downstream renders', () => {
    expect(describeServiceArea([])).toBe('');
  });
});

describe('buildServiceAreaSection', () => {
  it('is silent when no area is configured', () => {
    expect(buildServiceAreaSection([])).toBeNull();
    expect(buildServiceAreaSection(undefined as unknown as ServiceAreaEntry[])).toBeNull();
  });

  it('states the area and tells the bot to capture, not refuse, an out-of-area job', () => {
    const out = buildServiceAreaSection([province(OOST)])!;
    expect(out).toContain('## SERVICE AREA');
    expect(out).toContain('Oost-Vlaanderen');
    expect(out).toContain('OUT_OF_SERVICE_AREA');
    expect(out).toContain('request_appointment');
    // It must never teach the bot to turn the customer away.
    expect(out).not.toMatch(/cannot help|we don't serve/i);
  });
});

describe('{serviceArea} placeholder', () => {
  const ai = { enabled: true, brandVoice: { name: 'Ava', tone: 'friendly' } } as never;

  it('substitutes the configured area into a template body', () => {
    const { prompt } = composeSystemPrompt({
      mode: 'agent',
      ai,
      tenantName: 'Acme',
      tools: [],
      templateBody: 'We travel to {serviceArea}.',
      serviceArea: 'Oost-Vlaanderen, Sint-Niklaas',
    } as never);
    expect(prompt).toContain('We travel to Oost-Vlaanderen, Sint-Niklaas.');
  });

  it('resolves to empty rather than leaking a literal {serviceArea}', () => {
    const { prompt } = composeSystemPrompt({
      mode: 'agent',
      ai,
      tenantName: 'Acme',
      tools: [],
      templateBody: 'We travel to {serviceArea}.',
    } as never);
    expect(prompt).not.toContain('{serviceArea}');
    expect(prompt).toContain('We travel to .');
  });

  it('is catalogued as safe to expose, like {openingHours}', () => {
    const entry = PLACEHOLDER_CATALOG.find((e) => e.key === 'serviceArea');
    expect(entry).toMatchObject({ category: 'booking', safeToExpose: true, failClosed: '' });
  });
});

describe('serviceAreaSchema', () => {
  it('accepts what the field produces, including an empty array', () => {
    expect(serviceAreaSchema.safeParse([]).success).toBe(true);
    expect(
      serviceAreaSchema.safeParse([province(OOST), municipality('46021', 'Sint-Niklaas'), manual('30 km rond Aalst')])
        .success,
    ).toBe(true);
  });

  it('rejects an unlabelled entry and an unknown kind', () => {
    expect(serviceAreaSchema.safeParse([{ kind: 'province', id: OOST, label: '' }]).success).toBe(false);
    expect(serviceAreaSchema.safeParse([{ kind: 'country', id: 'BE', label: 'België' }]).success).toBe(false);
  });

  it('caps the list so the jsonb column stays bounded', () => {
    const many = Array.from({ length: MAX_SERVICE_AREA_ENTRIES + 1 }, (_, i) => manual(`place ${i}`));
    expect(serviceAreaSchema.safeParse(many).success).toBe(false);
  });
});

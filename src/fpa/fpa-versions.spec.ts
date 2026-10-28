import { Prisma } from '@prisma/client';
import {
  TRAVEL_COMBOS,
  diffParams,
  paramsGaps,
  paramsHash,
  paramsSnapshot,
} from './fpa-versions';

/**
 * FP&A (B2) — foto, hash, diferencias y faltantes de los parámetros de una
 * versión, con los de la B-26 (USD 20, EUR 22, inflación 4% y las tarifas de
 * la hoja '2').
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const TARIFAS = [
  ['nacional', 'colaborador', 4000, 2500, 500, 1000],
  ['nacional', 'director', 9000, 2500, 500, 2000],
  ['internacional', 'colaborador', 20000, 3500, 1000, 1500],
  ['internacional', 'director', 40000, 3500, 1000, 2500],
] as const;

const travel = (
  rows: ReadonlyArray<
    readonly [string, string, number, number, number, number]
  >,
) =>
  rows.map(([trip_type, traveler_type, f, h, t, m]) => ({
    trip_type,
    traveler_type,
    flight_per_person: D(f),
    hotel_per_night: D(h),
    transport_per_day: D(t),
    meals_per_day: D(m),
  }));

const B26 = {
  inflation_pct: D('4.000'),
  cutoff_month: null,
  params_source: 'Proyecciones Santander, sep-2025',
  exchange_rates: [
    { currency: 'USD', rate_mxn: D('20.000000') },
    { currency: 'EUR', rate_mxn: D('22.000000') },
  ],
  travel_rates: travel(TARIFAS),
};

describe('fpa-versions — foto y hash de los parámetros', () => {
  it('la foto es canónica: textos decimales y listas ordenadas', () => {
    const s = paramsSnapshot(B26);
    expect(s.inflation_pct).toBe('4.000');
    expect(s.exchange_rates).toEqual([
      { currency: 'EUR', rate_mxn: '22.000000' },
      { currency: 'USD', rate_mxn: '20.000000' },
    ]);
    expect(
      s.travel_rates.map((t) => `${t.trip_type}|${t.traveler_type}`),
    ).toEqual(TRAVEL_COMBOS.map((c) => `${c.trip_type}|${c.traveler_type}`));
    expect(s.travel_rates[1].flight_per_person).toBe('9000.00');
  });

  it('el hash no depende del orden ni de cómo vienen escritos los números', () => {
    const a = paramsHash(paramsSnapshot(B26));
    const b = paramsHash(
      paramsSnapshot({
        ...B26,
        inflation_pct: '4',
        exchange_rates: [
          { currency: 'USD', rate_mxn: '20' },
          { currency: 'EUR', rate_mxn: 22 },
        ],
        travel_rates: [...travel(TARIFAS)].reverse(),
      }),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('cualquier cambio cambia el hash (también la fuente)', () => {
    const base = paramsHash(paramsSnapshot(B26));
    expect(
      paramsHash(paramsSnapshot({ ...B26, inflation_pct: '3.7' })),
    ).not.toBe(base);
    expect(
      paramsHash(paramsSnapshot({ ...B26, params_source: 'Banxico' })),
    ).not.toBe(base);
    expect(
      paramsHash(
        paramsSnapshot({
          ...B26,
          exchange_rates: [{ currency: 'USD', rate_mxn: '20' }],
        }),
      ),
    ).not.toBe(base);
  });
});

describe('fpa-versions — qué cambió', () => {
  it('inflación, un tipo de cambio que cambia, otro que se quita y una tarifa', () => {
    const before = paramsSnapshot(B26);
    const after = paramsSnapshot({
      ...B26,
      inflation_pct: '3.700',
      exchange_rates: [{ currency: 'USD', rate_mxn: '19.5' }],
      travel_rates: travel([
        ['nacional', 'colaborador', 4500, 2500, 500, 1000],
        ...TARIFAS.slice(1),
      ]),
    });
    expect(
      diffParams(before, after).map((c) => [c.campo, c.antes, c.despues]),
    ).toEqual([
      ['inflation_pct', '4.000', '3.700'],
      ['rate:EUR', '22.000000', null],
      ['rate:USD', '20.000000', '19.500000'],
      ['travel:nacional:colaborador:flight_per_person', '4000.00', '4500.00'],
    ]);
  });

  it('sin cambios no hay diferencias', () => {
    expect(diffParams(paramsSnapshot(B26), paramsSnapshot(B26))).toEqual([]);
  });

  it('las etiquetas se leen en la pantalla', () => {
    const changes = diffParams(
      paramsSnapshot(B26),
      paramsSnapshot({ ...B26, params_source: null, travel_rates: [] }),
    );
    expect(changes[0]).toMatchObject({ campo: 'source', etiqueta: 'Fuente' });
    expect(changes.find((c) => c.campo.startsWith('travel:'))?.etiqueta).toBe(
      'Vuelo por persona · nacional · colaborador',
    );
  });
});

describe('fpa-versions — parámetros que faltan', () => {
  it('la B-26 está completa', () => {
    expect(
      paramsGaps(paramsSnapshot(B26), 'presupuesto', { currencies: ['USD'] }),
    ).toEqual([]);
  });

  it('una versión nueva: falta la inflación y las cuatro tarifas', () => {
    const gaps = paramsGaps(
      paramsSnapshot({
        inflation_pct: null,
        cutoff_month: null,
        params_source: null,
        exchange_rates: [],
        travel_rates: [],
      }),
      'presupuesto',
    );
    expect(gaps).toEqual([
      'Falta la inflación',
      'Falta la tarifa de viaje nacional para colaborador',
      'Falta la tarifa de viaje nacional para director',
      'Falta la tarifa de viaje internacional para colaborador',
      'Falta la tarifa de viaje internacional para director',
    ]);
  });

  it('el tipo de cambio de una moneda que ya usan las líneas', () => {
    const gaps = paramsGaps(
      paramsSnapshot({ ...B26, exchange_rates: [] }),
      'presupuesto',
      { currencies: ['USD', 'MXN', 'USD'] },
    );
    expect(gaps).toEqual([
      'Falta el tipo de cambio de USD, que ya usan líneas de la versión',
    ]);
  });

  it('un forecast sin mes de corte', () => {
    expect(paramsGaps(paramsSnapshot(B26), 'forecast')).toEqual([
      'Falta el mes de corte del forecast',
    ]);
  });
});

import {
  calcLine,
  CalcLineInput,
  CalcTravelRate,
  CalcVersion,
  lineDataErrors,
  money,
  round2,
  splitTotal,
  sumMonths,
  tripBreakdown,
  tripCost,
  type TripBreakdown,
} from './fpa-calc';
import { Prisma } from '@prisma/client';

/**
 * Casos con las cifras de los Excel de Laura (documentation/FPA.md, "Formato
 * único de captura" §3, y documentation/fpa/0021_fpa_pruebas.sql).
 */

const TARIFAS_B26: CalcTravelRate[] = [
  {
    trip_type: 'nacional',
    traveler_type: 'colaborador',
    flight_per_person: 4000,
    hotel_per_night: 2500,
    transport_per_day: 500,
    meals_per_day: 1000,
  },
  {
    trip_type: 'nacional',
    traveler_type: 'director',
    flight_per_person: 9000,
    hotel_per_night: 2500,
    transport_per_day: 500,
    meals_per_day: 2000,
  },
  {
    trip_type: 'internacional',
    traveler_type: 'colaborador',
    flight_per_person: 20000,
    hotel_per_night: 3500,
    transport_per_day: 1000,
    meals_per_day: 1500,
  },
  {
    trip_type: 'internacional',
    traveler_type: 'director',
    flight_per_person: 40000,
    hotel_per_night: 3500,
    transport_per_day: 1000,
    meals_per_day: 2500,
  },
];

/** B-26: USD 20, EUR 22, inflación 4%. */
const B26: CalcVersion = {
  inflation_pct: '4.000',
  cutoff_month: null,
  rates: { USD: '20.000000', EUR: '22.000000' },
  travel_rates: TARIFAS_B26,
};

const precioVeces = (
  unit_price: number | string,
  veces: Record<number, number | string>,
  extra: Partial<CalcLineInput> = {},
): CalcLineInput => ({
  calc_method: 'precio_veces',
  currency: 'MXN',
  price_index: 'precio_acordado',
  unit_price,
  months: Object.entries(veces).map(([month, quantity]) => ({
    month: Number(month),
    quantity,
  })),
  ...extra,
});

const viaje = (
  colaboradores: number,
  directores: number,
  noches: number,
  viajes: Record<number, number>,
  trip_type = 'nacional',
): CalcLineInput => ({
  calc_method: 'viaje',
  currency: 'MXN',
  price_index: 'precio_acordado',
  trip_type,
  travelers_colaborador: colaboradores,
  travelers_director: directores,
  nights: noches,
  months: Object.entries(viajes).map(([month, trips]) => ({
    month: Number(month),
    trips,
  })),
});

const mxn = (r: ReturnType<typeof calcLine>) => money(r.total_mxn);
const mes = (r: ReturnType<typeof calcLine>, m: number) =>
  money(r.months[m - 1].amount_mxn);

describe('fpa-calc — precio × veces', () => {
  it('ELVA (Compras B-26, Gastos sin viajes!3): 7,500 × 1 vez de febrero a mayo = $30,000', () => {
    const r = calcLine(precioVeces(7500, { 2: 1, 3: 1, 4: 1, 5: 1 }), B26);
    expect(mxn(r)).toBe('30000.00');
    expect(mes(r, 1)).toBe('0.00');
    expect(mes(r, 2)).toBe('7500.00');
    expect(mes(r, 5)).toBe('7500.00');
    expect(r.unavailable_reason).toBeNull();
  });

  it('CFE (Planta B-26, Gasto sin viaje!6): veces distintas por mes, con inflación = $3,536,000 y marzo $1,164,800', () => {
    const veces = [1, 15, 28, 1, 1, 10, 1, 1, 1, 10, 1, 15];
    const r = calcLine(
      precioVeces(40000, Object.fromEntries(veces.map((q, i) => [i + 1, q])), {
        price_index: 'inflacion',
      }),
      B26,
    );
    expect(mxn(r)).toBe('3536000.00');
    expect(mes(r, 3)).toBe('1164800.00');
  });

  it('Gympass (RH B-26, Gastos sin viajes!7): precio distinto por mes, 69,000 × 5 + 79,000 × 7 = $898,000', () => {
    const line: CalcLineInput = {
      calc_method: 'precio_veces',
      currency: 'MXN',
      price_index: 'precio_acordado',
      unit_price: 69000,
      months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((month) => ({
        month,
        quantity: 1,
        unit_price: month >= 6 ? 79000 : null,
      })),
    };
    const r = calcLine(line, B26);
    expect(mxn(r)).toBe('898000.00');
    expect(mes(r, 5)).toBe('69000.00');
    expect(mes(r, 6)).toBe('79000.00');
  });
});

describe('fpa-calc — otra moneda con el tipo de cambio de FP&A', () => {
  it('EYS (Finanzas B-26, Gastos sin viajes!8): EUR 65,000 × 1 vez en noviembre × 1.04 × 22 = $1,487,200', () => {
    const r = calcLine(
      precioVeces(
        65000,
        { 11: 1 },
        { currency: 'EUR', price_index: 'inflacion' },
      ),
      B26,
    );
    expect(mxn(r)).toBe('1487200.00');
    expect(money(r.total_currency)).toBe('67600.00');
  });

  it('PI System (Planta B-26, Gasto sin viaje!23): USD 130,000 × 1.04 × 20 = USD 135,200 = $2,704,000', () => {
    const r = calcLine(
      precioVeces(
        130000,
        { 6: 1 },
        { currency: 'USD', price_index: 'inflacion' },
      ),
      B26,
    );
    expect(money(r.total_currency)).toBe('135200.00');
    expect(mxn(r)).toBe('2704000.00');
  });

  it('INTER LAB (Planta B-26, fila 30): cada mes se redondea a centavos, 25,797.82 × 4 = $103,191.28 (Excel 103,191.296)', () => {
    const r = calcLine(
      precioVeces(
        '1240.28',
        { 3: 1, 6: 1, 9: 1, 12: 1 },
        { currency: 'USD', price_index: 'inflacion' },
      ),
      B26,
    );
    expect(mes(r, 3)).toBe('25797.82');
    expect(mxn(r)).toBe('103191.28');
    expect(money(r.months[2].amount_currency)).toBe('1289.89');
  });
});

describe('fpa-calc — monto por mes', () => {
  it('FIDELITAS (Compras B-26, fila 4): 30,000 de febrero a junio = $150,000', () => {
    const line: CalcLineInput = {
      calc_method: 'monto_mes',
      currency: 'MXN',
      price_index: 'precio_acordado',
      months: [2, 3, 4, 5, 6].map((month) => ({ month, amount: 30000 })),
    };
    expect(mxn(calcLine(line, B26))).toBe('150000.00');
  });

  it('Mapeo de Proceso (Compras F2/B27, fila 12): 100,000 × 12 en 2027 = $1,200,000', () => {
    const line: CalcLineInput = {
      calc_method: 'monto_mes',
      currency: 'MXN',
      price_index: 'precio_acordado',
      months: splitTotal(1200000, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    };
    const r = calcLine(line, { ...B26, inflation_pct: '3.700' });
    expect(mxn(r)).toBe('1200000.00');
    expect(mes(r, 1)).toBe('100000.00');
  });

  it('monto en USD con inflación: monto × 1.04 × 20', () => {
    const line: CalcLineInput = {
      calc_method: 'monto_mes',
      currency: 'USD',
      price_index: 'inflacion',
      months: [{ month: 1, amount: '1000' }],
    };
    const r = calcLine(line, B26);
    expect(money(r.total_currency)).toBe('1040.00');
    expect(mxn(r)).toBe('20800.00');
  });

  it('repartir un total: 1,000,000 / 12 = 83,333.33 × 11 + 83,333.37', () => {
    const parts = splitTotal(1000000, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(parts).toHaveLength(12);
    expect(parts[0].amount).toBe('83333.33');
    expect(parts[11].amount).toBe('83333.37');
    const total = parts.reduce(
      (acc, p) => acc.plus(new Prisma.Decimal(p.amount as string)),
      new Prisma.Decimal(0),
    );
    expect(total.toFixed(2)).toBe('1000000.00');
  });
});

describe('fpa-calc — viajes con las tarifas de la versión', () => {
  it('Compras B-26, Viajes!5: marzo, 2 colaboradores, nacional, 2 noches = $25,500', () => {
    const r = calcLine(viaje(2, 0, 2, { 3: 1 }), B26);
    expect(mes(r, 3)).toBe('25500.00');
    expect(mxn(r)).toBe('25500.00');
  });

  it('el mismo viaje en 2027 con tarifas × 1.037, cuatro viajes = 26,443.50 × 4 = $105,774', () => {
    const B27: CalcVersion = {
      ...B26,
      inflation_pct: '3.700',
      travel_rates: TARIFAS_B26.map((t) => ({
        ...t,
        flight_per_person: new Prisma.Decimal(t.flight_per_person).mul('1.037'),
        hotel_per_night: new Prisma.Decimal(t.hotel_per_night).mul('1.037'),
        transport_per_day: new Prisma.Decimal(t.transport_per_day).mul('1.037'),
        meals_per_day: new Prisma.Decimal(t.meals_per_day).mul('1.037'),
      })),
    };
    const r = calcLine(viaje(2, 0, 2, { 1: 1, 4: 1, 7: 1, 10: 1 }), B27);
    expect(mes(r, 1)).toBe('26443.50');
    expect(mxn(r)).toBe('105774.00');
  });

  it('viaje mixto (Visita a CFE): 1 director y 2 colaboradores, 1 noche = $33,500; el transporte va una vez', () => {
    const cost = tripCost(
      {
        trip_type: 'nacional',
        travelers_colaborador: 2,
        travelers_director: 1,
        nights: 1,
      },
      TARIFAS_B26,
    );
    expect(money(cost.cost)).toBe('33500.00');
  });

  it('Compras B-26 completo: 8 líneas = $2,659,000 (Resumen!H11)', () => {
    const lines: CalcLineInput[] = [
      precioVeces(7500, { 2: 1, 3: 1, 4: 1, 5: 1 }), // ELVA
      {
        calc_method: 'monto_mes',
        currency: 'MXN',
        price_index: 'precio_acordado',
        months: [2, 3, 4, 5, 6].map((month) => ({ month, amount: 30000 })),
      }, // FIDELITAS
      precioVeces(6000, { 12: 1 }), // Reunión anual
      precioVeces(
        195000,
        Object.fromEntries(
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => [m, 1]),
        ),
      ), // OTROS
      viaje(1, 0, 1, { 1: 1 }), // enero, 9,500
      viaje(1, 0, 4, { 2: 1 }), // febrero, 21,500
      viaje(2, 0, 2, { 3: 1 }), // marzo, 25,500
      viaje(2, 0, 2, { 6: 1, 9: 1, 11: 1 }), // "Seguimiento" jun, sep y nov, 76,500
    ];
    const results = lines.map((l) => calcLine(l, B26));
    expect(results.map((r) => mxn(r))).toEqual([
      '30000.00',
      '150000.00',
      '6000.00',
      '2340000.00',
      '9500.00',
      '21500.00',
      '25500.00',
      '76500.00',
    ]);
    const total = sumMonths(
      results.map((r) => r.months.map((m) => m.amount_mxn)),
    );
    expect(money(total.total)).toBe('2659000.00');
  });
});

describe('fpa-calc — desglose del viaje (B1, reunión del 26-oct)', () => {
  const sumParts = (b: TripBreakdown) =>
    b.travelers.reduce(
      (acc, t) => acc.plus(t.flight).plus(t.hotel).plus(t.meals),
      new Prisma.Decimal(b.transport.amount),
    );

  it('el viaje de la demo: 2 colaboradores y 1 director, nacional, 2 noches = $45,500 por viaje', () => {
    const { breakdown, reason } = tripBreakdown(
      {
        trip_type: 'nacional',
        travelers_colaborador: 2,
        travelers_director: 1,
        nights: 2,
      },
      TARIFAS_B26,
    );
    expect(reason).toBeNull();
    const b = breakdown as TripBreakdown;
    expect([b.nights, b.days]).toEqual([2, 3]);
    expect(
      b.travelers.map((t) => [
        t.traveler_type,
        t.count,
        money(t.flight),
        money(t.hotel),
        money(t.meals),
      ]),
    ).toEqual([
      ['colaborador', 2, '8000.00', '10000.00', '6000.00'],
      ['director', 1, '9000.00', '5000.00', '6000.00'],
    ]);
    expect([
      b.transport.traveler_type,
      money(b.transport.per_day),
      money(b.transport.amount),
    ]).toEqual(['director', '500.00', '1500.00']);
    expect(money(b.per_trip)).toBe('45500.00');
  });

  it('en la línea: un viaje en febrero y otro en mayo = $91,000, y el desglose dice cuántos viajes', () => {
    const r = calcLine(viaje(2, 1, 2, { 2: 1, 5: 1 }), B26);
    expect(mxn(r)).toBe('91000.00');
    expect(r.trip_breakdown?.trips).toBe(2);
    expect(money(r.trip_breakdown?.per_trip ?? null)).toBe('45500.00');
  });

  it('la suma del desglose es el costo del viaje en todos los casos', () => {
    const cases: Array<[number, number, number, string]> = [
      [1, 0, 1, 'nacional'], // 9,500
      [1, 0, 4, 'nacional'], // 21,500
      [2, 0, 2, 'nacional'], // 25,500
      [2, 1, 1, 'nacional'], // Visita a CFE, 33,500
      [0, 1, 0, 'nacional'], // director de ida y vuelta, 11,500
      [3, 2, 5, 'internacional'],
      [0, 2, 3, 'internacional'],
    ];
    for (const [c, d, n, t] of cases) {
      const line = {
        trip_type: t,
        travelers_colaborador: c,
        travelers_director: d,
        nights: n,
      };
      const b = tripBreakdown(line, TARIFAS_B26).breakdown as TripBreakdown;
      expect(money(sumParts(b))).toBe(money(b.per_trip));
      expect(money(b.per_trip)).toBe(money(tripCost(line, TARIFAS_B26).cost));
    }
    expect(
      money(
        tripCost(
          {
            trip_type: 'nacional',
            travelers_colaborador: 0,
            travelers_director: 1,
            nights: 0,
          },
          TARIFAS_B26,
        ).cost,
      ),
    ).toBe('11500.00');
  });

  it('solo colaboradores: el transporte va con su tarifa (internacional, 1 persona, 2 noches = $34,500)', () => {
    const b = tripBreakdown(
      {
        trip_type: 'internacional',
        travelers_colaborador: 1,
        travelers_director: 0,
        nights: 2,
      },
      TARIFAS_B26,
    ).breakdown as TripBreakdown;
    expect(b.travelers).toHaveLength(1);
    expect(b.transport.traveler_type).toBe('colaborador');
    expect(money(b.transport.amount)).toBe('3000.00');
    expect(money(b.per_trip)).toBe('34500.00');
  });

  it('sin tarifa para un tipo de viajero no hay desglose y la línea sale "No disponible"', () => {
    const sinDirector = TARIFAS_B26.filter(
      (t) => t.traveler_type !== 'director',
    );
    const r = tripBreakdown(
      {
        trip_type: 'nacional',
        travelers_colaborador: 1,
        travelers_director: 1,
        nights: 1,
      },
      sinDirector,
    );
    expect(r.breakdown).toBeNull();
    expect(r.reason).toMatch(/director/);
    const line = calcLine(viaje(1, 1, 1, { 3: 1 }), {
      ...B26,
      travel_rates: sinDirector,
    });
    expect(line.trip_breakdown).toBeNull();
    expect(line.total_mxn).toBeNull();
  });

  it('las otras formas de cálculo no traen desglose', () => {
    expect(
      calcLine(precioVeces(7500, { 2: 1 }), B26).trip_breakdown,
    ).toBeNull();
  });
});

describe('fpa-calc — "No disponible", nunca 0', () => {
  it('una moneda sin tipo de cambio en la versión', () => {
    const r = calcLine(precioVeces(100, { 1: 1 }, { currency: 'GBP' }), B26);
    expect(r.total_mxn).toBeNull();
    expect(r.months[0].amount_mxn).toBeNull();
    expect(r.months[1].amount_mxn?.toFixed(2)).toBe('0.00');
    expect(r.unavailable_reason).toMatch(/tipo de cambio de GBP/);
  });

  it('índice inflación sin inflación en la versión (no se calcula con factor 1)', () => {
    const r = calcLine(
      precioVeces(100, { 1: 1 }, { price_index: 'inflacion' }),
      { ...B26, inflation_pct: null },
    );
    expect(r.total_mxn).toBeNull();
    expect(r.unavailable_reason).toMatch(/inflación/);
  });

  it('un viaje sin tarifa para uno de sus tipos de viajero', () => {
    const r = calcLine(viaje(1, 1, 1, { 1: 1 }), {
      ...B26,
      travel_rates: TARIFAS_B26.filter((t) => t.traveler_type !== 'director'),
    });
    expect(r.total_mxn).toBeNull();
    expect(r.unavailable_reason).toMatch(/director/);
  });

  it('la suma propaga "No disponible" al mes y al total', () => {
    const ok = calcLine(precioVeces(10, { 1: 1, 2: 1 }), B26);
    const na = calcLine(precioVeces(10, { 2: 1 }, { currency: 'GBP' }), B26);
    const sum = sumMonths([
      ok.months.map((m) => m.amount_mxn),
      na.months.map((m) => m.amount_mxn),
    ]);
    expect(money(sum.months[0])).toBe('10.00');
    expect(sum.months[1]).toBeNull();
    expect(sum.total).toBeNull();
  });
});

describe('fpa-calc — datos que no corresponden son error, no se omiten', () => {
  it('un monto en una línea de precio × veces', () => {
    const line: CalcLineInput = {
      ...precioVeces(100, {}),
      months: [{ month: 1, amount: 50 }],
    };
    expect(lineDataErrors(line, null)).toEqual([
      'En precio × veces, el mes 1 debe traer las veces',
    ]);
    expect(calcLine(line, B26).total_mxn).toBeNull();
  });

  it('un mes hasta el corte de un forecast', () => {
    const line = precioVeces(100, { 8: 1, 9: 1 });
    const errors = lineDataErrors(line, 8);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/mes 8 ya es real/);
  });

  it('un mes con dos datos o repetido', () => {
    const line: CalcLineInput = {
      ...precioVeces(100, {}),
      months: [
        { month: 1, quantity: 1, amount: 5 },
        { month: 2, quantity: 1 },
        { month: 2, quantity: 2 },
      ],
    };
    const errors = lineDataErrors(line, null);
    expect(errors).toContain('El mes 1 debe traer un solo dato');
    expect(errors).toContain('El mes 2 viene dos veces');
  });
});

describe('fpa-calc — redondeo', () => {
  it('el medio centavo sube, como round() de PostgreSQL', () => {
    expect(round2(new Prisma.Decimal('0.125')).toFixed(2)).toBe('0.13');
    expect(round2(new Prisma.Decimal('-0.125')).toFixed(2)).toBe('-0.13');
  });

  it('aritmética decimal, no float: 0.1 + 0.2 = 0.30', () => {
    const line: CalcLineInput = {
      calc_method: 'monto_mes',
      currency: 'MXN',
      price_index: 'precio_acordado',
      months: [
        { month: 1, amount: '0.1' },
        { month: 2, amount: '0.2' },
      ],
    };
    expect(mxn(calcLine(line, B26))).toBe('0.30');
  });
});

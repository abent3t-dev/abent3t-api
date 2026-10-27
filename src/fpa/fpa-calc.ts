import { Prisma } from '@prisma/client';

/**
 * FP&A (A3) — cálculo de las líneas de presupuesto. Funciones puras: no leen
 * la base. Diseño: documentation/FPA.md, "Diseño" §6.
 *
 * - Se guarda solo lo capturado; aquí se calcula cada mes en la moneda de la
 *   línea y en pesos con los parámetros de la versión (inflación, tipos de
 *   cambio y tarifas de viaje).
 * - Cada mes se redondea a centavos desde el producto sin redondear (redondeo
 *   comercial: el medio centavo sube, como round() de PostgreSQL). El total de
 *   la línea es la suma de sus meses.
 * - Si falta un parámetro que la línea usa, la línea sale "No disponible"
 *   (null), nunca 0 ni con factor 1. Un dato que no corresponde a la forma de
 *   cálculo (veces en un viaje, un mes hasta el corte de un forecast) es un
 *   error: se marca, no se omite.
 */

const D = Prisma.Decimal;
type Decimal = Prisma.Decimal;
type Num = Prisma.Decimal | string | number;

export type CalcMethod = 'precio_veces' | 'monto_mes' | 'viaje';
export type PriceIndex = 'precio_acordado' | 'inflacion';
export type TripType = 'nacional' | 'internacional';
export type TravelerType = 'colaborador' | 'director';

export const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

export interface CalcTravelRate {
  trip_type: string;
  traveler_type: string;
  flight_per_person: Num;
  hotel_per_night: Num;
  transport_per_day: Num;
  meals_per_day: Num;
}

/** Parámetros de la versión que usa el cálculo (solo los activos). */
export interface CalcVersion {
  /** Inflación en % (4 = 4%). null = FP&A no la ha fijado. */
  inflation_pct: Num | null;
  /** Mes de corte de un forecast (meses 1..corte no se capturan). */
  cutoff_month: number | null;
  /** Pesos por unidad, por moneda (sin MXN). */
  rates: Record<string, Num>;
  travel_rates: CalcTravelRate[];
}

export interface CalcMonthInput {
  month: number;
  quantity?: Num | null;
  unit_price?: Num | null;
  amount?: Num | null;
  trips?: number | null;
}

export interface CalcLineInput {
  /** precio_veces | monto_mes | viaje (texto, como llega de la base). */
  calc_method: string;
  currency: string;
  /** precio_acordado | inflacion */
  price_index: string;
  unit_price?: Num | null;
  trip_type?: string | null;
  travelers_colaborador?: number | null;
  travelers_director?: number | null;
  nights?: number | null;
  months: CalcMonthInput[];
}

export interface CalcMonthResult {
  month: number;
  /** null = "No disponible". */
  amount_currency: Decimal | null;
  amount_mxn: Decimal | null;
}

/** Lo que cuesta UN viaje para un tipo de viajero, con las tarifas de la versión. */
export interface TripTravelerCost {
  traveler_type: TravelerType;
  count: number;
  flight_per_person: Decimal;
  hotel_per_night: Decimal;
  meals_per_day: Decimal;
  /** vuelo × personas */
  flight: Decimal;
  /** noches × hotel × personas */
  hotel: Decimal;
  /** días × alimentos × personas */
  meals: Decimal;
}

/**
 * Desglose de UN viaje en pesos (B1, reunión del 26-oct, 34:38): lo que pidió
 * Laura ver en la pantalla. Su suma es `per_trip`, el mismo costo que usa el
 * cálculo de la línea.
 */
export interface TripBreakdown {
  trip_type: string;
  nights: number;
  /** noches + 1 */
  days: number;
  /** Solo los tipos de viajero que van (colaborador y luego director). */
  travelers: TripTravelerCost[];
  /** Una vez por viaje, sin personas: tarifa de director si va al menos uno. */
  transport: { traveler_type: TravelerType; per_day: Decimal; amount: Decimal };
  per_trip: Decimal;
}

export interface CalcLineResult {
  /** Siempre 12 meses (1..12). */
  months: CalcMonthResult[];
  total_currency: Decimal | null;
  total_mxn: Decimal | null;
  /** Por qué la línea sale "No disponible"; null si se pudo calcular. */
  unavailable_reason: string | null;
  /**
   * Viaje: el desglose de un viaje y cuántos viajes hay en el año (total =
   * per_trip × trips). null en las otras formas o si la línea no se calculó.
   */
  trip_breakdown: (TripBreakdown & { trips: number }) | null;
}

const ZERO = new D(0);

const isSet = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== '';

const dec = (v: Num): Decimal => new D(v);

/** Redondeo a centavos, el medio centavo sube (como round() de PostgreSQL). */
export function round2(v: Decimal): Decimal {
  return v.toDecimalPlaces(2, D.ROUND_HALF_UP);
}

/** Factor del índice: precio acordado = 1; inflación = 1 + tasa/100. */
export function indexFactor(
  priceIndex: string,
  inflationPct: Num | null,
): { factor: Decimal | null; reason: string | null } {
  if (priceIndex === 'precio_acordado')
    return { factor: new D(1), reason: null };
  if (priceIndex === 'inflacion') {
    if (!isSet(inflationPct)) {
      return { factor: null, reason: 'La versión no tiene inflación' };
    }
    return {
      factor: dec(inflationPct as Num)
        .div(100)
        .plus(1),
      reason: null,
    };
  }
  return { factor: null, reason: `Índice desconocido: ${priceIndex}` };
}

/** Tipo de cambio de la versión: MXN = 1; otra moneda, el de la versión. */
export function exchangeRate(
  currency: string,
  rates: Record<string, Num>,
): { rate: Decimal | null; reason: string | null } {
  if (currency === 'MXN') return { rate: new D(1), reason: null };
  const rate = rates[currency];
  if (!isSet(rate)) {
    return {
      rate: null,
      reason: `La versión no tiene tipo de cambio de ${currency}`,
    };
  }
  return { rate: dec(rate), reason: null };
}

type TripFields = Pick<
  CalcLineInput,
  'trip_type' | 'travelers_colaborador' | 'travelers_director' | 'nights'
>;

/**
 * Desglose de UN viaje, en pesos, con las tarifas de la versión: por cada tipo
 * de viajero que va, vuelo × personas, noches × hotel × personas y
 * (noches + 1) × alimentos × personas; más (noches + 1) × transporte, una vez
 * por viaje y sin personas, con la tarifa de director si va al menos un
 * director y si no, la de colaborador.
 */
export function tripBreakdown(
  line: TripFields,
  travelRates: CalcTravelRate[],
): { breakdown: TripBreakdown | null; reason: string | null } {
  const tripType = line.trip_type ?? '';
  const nightsCount = line.nights ?? 0;
  const nights = new D(nightsCount);
  const days = nights.plus(1);
  const counts: Array<[TravelerType, number]> = [
    ['colaborador', line.travelers_colaborador ?? 0],
    ['director', line.travelers_director ?? 0],
  ];
  const rateFor = (traveler: TravelerType) =>
    travelRates.find(
      (r) => r.trip_type === tripType && r.traveler_type === traveler,
    );

  const travelers: TripTravelerCost[] = [];
  for (const [traveler, count] of counts) {
    if (count <= 0) continue;
    const rate = rateFor(traveler);
    if (!rate) {
      return {
        breakdown: null,
        reason: `La versión no tiene tarifa de viaje ${tripType} para ${traveler}`,
      };
    }
    const flightRate = dec(rate.flight_per_person);
    const hotelRate = dec(rate.hotel_per_night);
    const mealsRate = dec(rate.meals_per_day);
    travelers.push({
      traveler_type: traveler,
      count,
      flight_per_person: flightRate,
      hotel_per_night: hotelRate,
      meals_per_day: mealsRate,
      flight: flightRate.mul(count),
      hotel: nights.mul(hotelRate).mul(count),
      meals: days.mul(mealsRate).mul(count),
    });
  }
  const transportType: TravelerType =
    (line.travelers_director ?? 0) > 0 ? 'director' : 'colaborador';
  const transportRate = rateFor(transportType);
  if (!transportRate) {
    return {
      breakdown: null,
      reason: `La versión no tiene tarifa de viaje ${tripType}`,
    };
  }
  const perDay = dec(transportRate.transport_per_day);
  const transport = {
    traveler_type: transportType,
    per_day: perDay,
    amount: days.mul(perDay),
  };
  const perTrip = travelers.reduce(
    (acc, t) => acc.plus(t.flight).plus(t.hotel).plus(t.meals),
    transport.amount,
  );
  return {
    breakdown: {
      trip_type: tripType,
      nights: nightsCount,
      days: nightsCount + 1,
      travelers,
      transport,
      per_trip: perTrip,
    },
    reason: null,
  };
}

/** Costo de UN viaje, en pesos: la suma del desglose de `tripBreakdown`. */
export function tripCost(
  line: TripFields,
  travelRates: CalcTravelRate[],
): { cost: Decimal | null; reason: string | null } {
  const { breakdown, reason } = tripBreakdown(line, travelRates);
  return { cost: breakdown?.per_trip ?? null, reason };
}

/**
 * Errores de datos: lo capturado que no corresponde a la forma de cálculo o
 * que cae en un mes cerrado de un forecast. Se usa al guardar (el service lo
 * rechaza) y en el cálculo (la línea sale "No disponible" con el motivo).
 */
export function lineDataErrors(
  line: CalcLineInput,
  cutoffMonth: number | null,
): string[] {
  const errors: string[] = [];
  const seen = new Set<number>();
  for (const m of line.months) {
    if (!Number.isInteger(m.month) || m.month < 1 || m.month > 12) {
      errors.push(`Mes inválido: ${m.month}`);
      continue;
    }
    if (seen.has(m.month)) errors.push(`El mes ${m.month} viene dos veces`);
    seen.add(m.month);
    if (cutoffMonth && m.month <= cutoffMonth) {
      errors.push(
        `El mes ${m.month} ya es real en este forecast (corte en ${cutoffMonth}); no se captura`,
      );
    }
    const hasQty = isSet(m.quantity);
    const hasAmount = isSet(m.amount);
    const hasTrips = isSet(m.trips);
    const filled = [hasQty, hasAmount, hasTrips].filter(Boolean).length;
    if (filled !== 1) {
      errors.push(`El mes ${m.month} debe traer un solo dato`);
      continue;
    }
    if (isSet(m.unit_price) && !hasQty) {
      errors.push(`El mes ${m.month} trae precio sin veces`);
    }
    if (line.calc_method === 'precio_veces' && !hasQty) {
      errors.push(`En precio × veces, el mes ${m.month} debe traer las veces`);
    }
    if (line.calc_method === 'monto_mes' && !hasAmount) {
      errors.push(`En monto por mes, el mes ${m.month} debe traer el monto`);
    }
    if (line.calc_method === 'viaje' && !hasTrips) {
      errors.push(`En viaje, el mes ${m.month} debe traer los viajes`);
    }
  }
  return errors;
}

/** Calcula los 12 meses y el total de una línea con los parámetros de la versión. */
export function calcLine(
  line: CalcLineInput,
  version: CalcVersion,
): CalcLineResult {
  const empty = (value: Decimal | null): CalcMonthResult[] =>
    MONTHS.map((month) => ({
      month,
      amount_currency: line.months.some((m) => m.month === month)
        ? value
        : ZERO,
      amount_mxn: line.months.some((m) => m.month === month) ? value : ZERO,
    }));
  const unavailable = (reason: string): CalcLineResult => ({
    months: empty(null),
    total_currency: null,
    total_mxn: null,
    unavailable_reason: reason,
    trip_breakdown: null,
  });

  const errors = lineDataErrors(line, version.cutoff_month);
  if (errors.length > 0) return unavailable(errors[0]);

  // Viaje: siempre en pesos y con precio acordado (las tarifas ya son de la versión)
  let factor: Decimal;
  let rate: Decimal;
  let perTrip: Decimal | null = null;
  let breakdown: TripBreakdown | null = null;
  if (line.calc_method === 'viaje') {
    const trip = tripBreakdown(line, version.travel_rates);
    if (trip.breakdown === null)
      return unavailable(trip.reason ?? 'Sin tarifa');
    breakdown = trip.breakdown;
    perTrip = trip.breakdown.per_trip;
    factor = new D(1);
    rate = new D(1);
  } else {
    const idx = indexFactor(line.price_index, version.inflation_pct);
    if (idx.factor === null) return unavailable(idx.reason ?? 'Sin inflación');
    const fx = exchangeRate(line.currency, version.rates);
    if (fx.rate === null) return unavailable(fx.reason ?? 'Sin tipo de cambio');
    factor = idx.factor;
    rate = fx.rate;
  }

  const months: CalcMonthResult[] = MONTHS.map((month) => {
    const m = line.months.find((x) => x.month === month);
    if (!m) return { month, amount_currency: ZERO, amount_mxn: ZERO };
    let base: Decimal;
    if (line.calc_method === 'precio_veces') {
      const price = isSet(m.unit_price) ? m.unit_price : line.unit_price;
      base = dec(m.quantity as Num).mul(dec(price ?? 0));
    } else if (line.calc_method === 'monto_mes') {
      base = dec(m.amount as Num);
    } else {
      base = new D(m.trips ?? 0).mul(perTrip as Decimal);
    }
    const inCurrency = base.mul(factor);
    return {
      month,
      amount_currency: round2(inCurrency),
      amount_mxn: round2(inCurrency.mul(rate)),
    };
  });

  return {
    months,
    total_currency: months.reduce(
      (acc, m) => acc.plus(m.amount_currency as Decimal),
      ZERO,
    ),
    total_mxn: months.reduce(
      (acc, m) => acc.plus(m.amount_mxn as Decimal),
      ZERO,
    ),
    unavailable_reason: null,
    trip_breakdown: breakdown
      ? {
          ...breakdown,
          trips: line.months.reduce((acc, m) => acc + (m.trips ?? 0), 0),
        }
      : null,
  };
}

/**
 * Suma meses en pesos de varias líneas. Si alguna línea es "No disponible"
 * en un mes, ese mes del total también; el total anual, si cualquier mes lo es.
 */
export function sumMonths(lines: Array<Array<Decimal | null>>): {
  months: Array<Decimal | null>;
  total: Decimal | null;
} {
  const months: Array<Decimal | null> = MONTHS.map((_, i) => {
    let acc: Decimal | null = ZERO;
    for (const line of lines) {
      const v = line[i];
      if (v === null || acc === null) {
        acc = null;
        continue;
      }
      acc = acc.plus(v);
    }
    return acc;
  });
  const total = months.some((m) => m === null)
    ? null
    : months.reduce((acc: Decimal, m) => acc.plus(m as Decimal), ZERO);
  return { months, total };
}

/**
 * Apoyo de captura "repartir un total": parte el total entre los meses
 * marcados, redondeado a centavos, y el último absorbe la diferencia
 * (1,000,000 / 12 = 83,333.33 × 11 + 83,333.37).
 */
export function splitTotal(total: Num, months: number[]): CalcMonthInput[] {
  const sorted = [...new Set(months)].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const t = dec(total);
  const part = round2(t.div(sorted.length));
  const last = t.minus(part.mul(sorted.length - 1));
  return sorted.map((month, i) => ({
    month,
    amount: (i === sorted.length - 1 ? last : part).toFixed(2),
  }));
}

/** Monto para el API: string con 2 decimales; null = "No disponible". */
export function money(v: Decimal | null): string | null {
  return v === null ? null : v.toFixed(2);
}

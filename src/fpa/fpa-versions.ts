import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

/**
 * FP&A (B2) — parámetros de una versión: funciones puras, sin base. Diseño:
 * documentation/FPA.md, "Bloque B: avance" (B2), y "Diseño" §5.
 *
 * Los parámetros de una versión son la inflación, el mes de corte (forecast),
 * los tipos de cambio, las tarifas de viaje y la fuente. Laura los carga y el
 * firmante de planeación (David) les da el visto bueno; la foto canónica y su
 * hash sirven para saber si cambiaron entre que alguien los revisó y los
 * aprobó, y para guardar en el historial qué se aprobó y qué cambió.
 */

type Num = Prisma.Decimal | string | number;

export const TRIP_TYPES = ['nacional', 'internacional'] as const;
export const TRAVELER_TYPES = ['colaborador', 'director'] as const;

/** Las cuatro tarifas de viaje que pide toda versión (hoja '2' de los B-26). */
export const TRAVEL_COMBOS = TRIP_TYPES.flatMap((trip_type) =>
  TRAVELER_TYPES.map((traveler_type) => ({ trip_type, traveler_type })),
);

export const TRAVEL_FIELDS = [
  'flight_per_person',
  'hotel_per_night',
  'transport_per_day',
  'meals_per_day',
] as const;
export type TravelField = (typeof TRAVEL_FIELDS)[number];

export const TRAVEL_FIELD_LABELS: Record<TravelField, string> = {
  flight_per_person: 'Vuelo por persona',
  hotel_per_night: 'Hotel por noche',
  transport_per_day: 'Transporte por día',
  meals_per_day: 'Alimentos por día',
};

const TRIP_LABELS: Record<string, string> = {
  nacional: 'nacional',
  internacional: 'internacional',
};

export interface TravelRateParams {
  trip_type: string;
  traveler_type: string;
  flight_per_person: string;
  hotel_per_night: string;
  transport_per_day: string;
  meals_per_day: string;
}

/** Foto canónica de los parámetros: textos decimales y listas ordenadas. */
export interface ParamsSnapshot {
  /** Inflación en % con 3 decimales ("4.000"); null = sin fijar. */
  inflation_pct: string | null;
  /** Mes de corte (solo forecast). */
  cutoff_month: number | null;
  source: string | null;
  /** Ordenados por moneda; pesos por unidad con 6 decimales. */
  exchange_rates: Array<{ currency: string; rate_mxn: string }>;
  /** En el orden de TRAVEL_COMBOS; montos con 2 decimales. */
  travel_rates: TravelRateParams[];
}

const fixed = (v: Num, places: number): string =>
  new Prisma.Decimal(v).toFixed(places);

const comboKey = (trip: string, traveler: string) => `${trip}|${traveler}`;
const comboOrder = (trip: string, traveler: string) => {
  const i = TRAVEL_COMBOS.findIndex(
    (c) => c.trip_type === trip && c.traveler_type === traveler,
  );
  return i === -1 ? TRAVEL_COMBOS.length : i;
};

/** Arma la foto canónica con los parámetros activos de la versión. */
export function paramsSnapshot(input: {
  inflation_pct: Num | null;
  cutoff_month: number | null;
  params_source: string | null;
  exchange_rates: Array<{ currency: string; rate_mxn: Num }>;
  travel_rates: Array<{
    trip_type: string;
    traveler_type: string;
    flight_per_person: Num;
    hotel_per_night: Num;
    transport_per_day: Num;
    meals_per_day: Num;
  }>;
}): ParamsSnapshot {
  return {
    inflation_pct:
      input.inflation_pct === null || input.inflation_pct === undefined
        ? null
        : fixed(input.inflation_pct, 3),
    cutoff_month: input.cutoff_month ?? null,
    source: input.params_source?.trim() || null,
    exchange_rates: [...input.exchange_rates]
      .map((r) => ({ currency: r.currency, rate_mxn: fixed(r.rate_mxn, 6) }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    travel_rates: [...input.travel_rates]
      .map((t) => ({
        trip_type: t.trip_type,
        traveler_type: t.traveler_type,
        flight_per_person: fixed(t.flight_per_person, 2),
        hotel_per_night: fixed(t.hotel_per_night, 2),
        transport_per_day: fixed(t.transport_per_day, 2),
        meals_per_day: fixed(t.meals_per_day, 2),
      }))
      .sort(
        (a, b) =>
          comboOrder(a.trip_type, a.traveler_type) -
          comboOrder(b.trip_type, b.traveler_type),
      ),
  };
}

/**
 * Hash corto de la foto: lo manda quien revisa los parámetros al dar el visto
 * bueno (o al guardarlos), para no aprobar ni pisar algo que cambió mientras
 * los tenía en pantalla.
 */
export function paramsHash(s: ParamsSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(s))
    .digest('hex')
    .slice(0, 16);
}

export interface ParamChange {
  /** inflation_pct | cutoff_month | source | rate:USD | travel:nacional:director:flight_per_person */
  campo: string;
  etiqueta: string;
  antes: string | null;
  despues: string | null;
}

/** Qué cambió entre dos fotos, en el orden de la pantalla. */
export function diffParams(
  before: ParamsSnapshot,
  after: ParamsSnapshot,
): ParamChange[] {
  const changes: ParamChange[] = [];
  const push = (
    campo: string,
    etiqueta: string,
    antes: string | null,
    despues: string | null,
  ) => {
    if (antes !== despues) changes.push({ campo, etiqueta, antes, despues });
  };
  push(
    'inflation_pct',
    'Inflación (%)',
    before.inflation_pct,
    after.inflation_pct,
  );
  push(
    'cutoff_month',
    'Mes de corte',
    before.cutoff_month === null ? null : String(before.cutoff_month),
    after.cutoff_month === null ? null : String(after.cutoff_month),
  );
  push('source', 'Fuente', before.source, after.source);

  const currencies = [
    ...new Set([
      ...before.exchange_rates.map((r) => r.currency),
      ...after.exchange_rates.map((r) => r.currency),
    ]),
  ].sort();
  for (const currency of currencies) {
    push(
      `rate:${currency}`,
      `Tipo de cambio ${currency}`,
      before.exchange_rates.find((r) => r.currency === currency)?.rate_mxn ??
        null,
      after.exchange_rates.find((r) => r.currency === currency)?.rate_mxn ??
        null,
    );
  }

  const travel = (s: ParamsSnapshot) =>
    new Map(
      s.travel_rates.map((t) => [comboKey(t.trip_type, t.traveler_type), t]),
    );
  const b = travel(before);
  const a = travel(after);
  const combos = [
    ...TRAVEL_COMBOS.map((c) => comboKey(c.trip_type, c.traveler_type)),
    ...[...new Set([...b.keys(), ...a.keys()])].filter(
      (k) =>
        !TRAVEL_COMBOS.some(
          (c) => comboKey(c.trip_type, c.traveler_type) === k,
        ),
    ),
  ];
  for (const key of combos) {
    const [trip, traveler] = key.split('|');
    for (const field of TRAVEL_FIELDS) {
      push(
        `travel:${trip}:${traveler}:${field}`,
        `${TRAVEL_FIELD_LABELS[field]} · ${TRIP_LABELS[trip] ?? trip} · ${traveler}`,
        b.get(key)?.[field] ?? null,
        a.get(key)?.[field] ?? null,
      );
    }
  }
  return changes;
}

/** Qué usan las líneas de la versión (para exigir sus parámetros al abrirla). */
export interface ParamsUsage {
  /** Monedas distintas de MXN de las líneas vivas. */
  currencies: string[];
}

/**
 * Parámetros que faltan para dar el visto bueno o abrir la versión a captura:
 * la inflación, las cuatro tarifas de viaje y el tipo de cambio de cada moneda
 * que ya usan sus líneas; en un forecast, el mes de corte. Vacío = completos.
 */
export function paramsGaps(
  s: ParamsSnapshot,
  kind: string,
  usage: ParamsUsage = { currencies: [] },
): string[] {
  const gaps: string[] = [];
  if (s.inflation_pct === null) gaps.push('Falta la inflación');
  if (kind === 'forecast' && s.cutoff_month === null) {
    gaps.push('Falta el mes de corte del forecast');
  }
  for (const c of TRAVEL_COMBOS) {
    if (
      !s.travel_rates.some(
        (t) =>
          t.trip_type === c.trip_type && t.traveler_type === c.traveler_type,
      )
    ) {
      gaps.push(
        `Falta la tarifa de viaje ${TRIP_LABELS[c.trip_type]} para ${c.traveler_type}`,
      );
    }
  }
  for (const currency of [...new Set(usage.currencies)].sort()) {
    if (currency === 'MXN') continue;
    if (!s.exchange_rates.some((r) => r.currency === currency)) {
      gaps.push(
        `Falta el tipo de cambio de ${currency}, que ya usan líneas de la versión`,
      );
    }
  }
  return gaps;
}

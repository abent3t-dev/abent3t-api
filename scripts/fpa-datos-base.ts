/**
 * FP&A — datos base que comparten `fpa-seed-dev` (dev, con usuarios de prueba)
 * y `fpa-arranque` (prod, primer acceso de planeación, sin usuarios de prueba).
 * Así dev y prod cargan exactamente lo mismo.
 *
 * Cifras reales de los Excel de Laura (documentation/FPA.md, "Formato único de
 * captura", y documentation/fpa/0021_fpa_pruebas.sql):
 *   - catálogo base de categorías y clasificaciones (orden del reporte). Se
 *     reemplaza por el del Chart of Accounts en el bloque B (B5);
 *   - la versión B-26 en captura, con inflación 4%, USD 20 / EUR 22 y las
 *     tarifas de viaje de la hoja '2';
 *   - áreas Compras, Planta y Recursos Humanos, cada una con su departamento
 *     propio, y los departamentos SSGG e IT que captura RH;
 *   - el B-26 completo de Compras (8 líneas = $2,659,000, Resumen!H11), PI
 *     System e INTER LAB de Planta, y Gympass y una capacitación de RH.
 *
 * Idempotente: lo que ya existe se reutiliza y nada se borra (la app no tiene
 * DELETE en las tablas fpa_). Los nombres se buscan sin distinguir mayúsculas,
 * como la pantalla de Áreas. Las líneas se reconocen por su source_ref; una
 * línea que se dio de baja en la plataforma solo se vuelve a crear con
 * `restoreInactiveLines` (el seed de dev sí; el arranque de prod no).
 */
import { Prisma } from '@prisma/client';
import { calcLine } from '../src/fpa/fpa-calc';

export type Tx = Prisma.TransactionClient;

export const CATALOG: Array<{
  name: string;
  sort: number;
  classifications: Array<{ name: string; allows_negative?: boolean }>;
}> = [
  {
    name: 'Servicios Profesionales',
    sort: 1,
    classifications: [
      { name: 'Servicios Profesionales' },
      { name: 'Asesoría Comercial' },
      { name: 'Facturación y Lecturas' },
    ],
  },
  {
    name: 'Consultorías',
    sort: 2,
    classifications: [
      { name: 'Consultorías' },
      { name: 'Consultorías Fiscal' },
    ],
  },
  { name: 'Auditorías', sort: 3, classifications: [{ name: 'Auditorías' }] },
  {
    name: 'Comunicaciones',
    sort: 4,
    classifications: [
      { name: 'Internet' },
      { name: 'Telefonía Celular' },
      { name: 'Telefonía Fija' },
      { name: 'Otras Comunicaciones' },
    ],
  },
  {
    name: 'Arrendamientos',
    sort: 5,
    classifications: [
      { name: 'Renta Oficina' },
      { name: 'Renta de Vehículos' },
      { name: 'Renta de Equipo de Cómputo' },
    ],
  },
  {
    name: 'Cuotas y Suscripciones',
    sort: 6,
    classifications: [{ name: 'Cuotas y Suscripciones' }],
  },
  {
    name: 'Otros',
    sort: 7,
    classifications: [{ name: 'Otros' }, { name: 'No deducibles' }],
  },
  {
    name: 'Viajes',
    sort: 8,
    classifications: [
      { name: 'Viajes' },
      { name: 'Hospedaje' },
      { name: 'Alimentos' },
      { name: 'Transporte' },
      { name: 'Renta de autos' },
    ],
  },
  {
    name: 'Eventos',
    sort: 9,
    classifications: [
      { name: 'Equipo' },
      { name: 'Proveedores' },
      { name: 'Clientes' },
    ],
  },
  {
    name: 'Servicios Administrados y Licencias',
    sort: 10,
    classifications: [{ name: 'Servicios Administrados y Licencias' }],
  },
  {
    name: 'Derechos y Permisos',
    sort: 11,
    classifications: [{ name: 'Derechos y Permisos' }],
  },
  {
    name: 'Beneficios',
    sort: 12,
    classifications: [
      { name: 'Gimnasio' },
      { name: 'Vales' },
      { name: 'Seguros' },
      { name: 'Descuento Vales Restaurante', allows_negative: true },
    ],
  },
  {
    name: 'Capacitación',
    sort: 13,
    classifications: [{ name: 'Capacitación' }],
  },
];

export const AREAS = [
  { name: 'Compras', sort: 1 },
  { name: 'Planta', sort: 2 },
  { name: 'Recursos Humanos', sort: 3 },
];

interface BaseLine {
  area: string;
  department: string;
  category: string;
  classification: string;
  concept: string;
  supplier: string | null;
  calc_method: 'precio_veces' | 'monto_mes' | 'viaje';
  currency: string;
  price_index: 'precio_acordado' | 'inflacion';
  unit_price?: number;
  trip?: {
    travelers_colaborador: number;
    travelers_director: number;
    nights: number;
  };
  months: Array<{
    month: number;
    quantity?: number;
    unit_price?: number;
    amount?: number;
    trips?: number;
  }>;
  source_ref: string;
  /** Cifra de Laura para comprobar al final. */
  expected: number;
}

const all12 = (fn: (m: number) => Record<string, number | undefined>) =>
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((month) => ({
    month,
    ...fn(month),
  }));

export const LINES: BaseLine[] = [
  {
    area: 'Compras',
    department: 'Compras',
    category: 'Servicios Profesionales',
    classification: 'Servicios Profesionales',
    concept: 'Proyecto de mejora dashboard Compras',
    supplier: 'ELVA MARIA LARA PALOMARES',
    calc_method: 'precio_veces',
    currency: 'MXN',
    price_index: 'precio_acordado',
    unit_price: 7500,
    months: [2, 3, 4, 5].map((month) => ({ month, quantity: 1 })),
    source_ref: 'Compras B-26, Gastos sin viajes!3',
    expected: 30000,
  },
  {
    area: 'Compras',
    department: 'Compras',
    category: 'Servicios Profesionales',
    classification: 'Servicios Profesionales',
    concept: 'Evaluación de proveedores',
    supplier: 'FIDELITAS',
    calc_method: 'monto_mes',
    currency: 'MXN',
    price_index: 'precio_acordado',
    months: [2, 3, 4, 5, 6].map((month) => ({ month, amount: 30000 })),
    source_ref: 'Compras B-26, Gastos sin viajes!4',
    expected: 150000,
  },
  {
    area: 'Compras',
    department: 'Compras',
    category: 'Comunicaciones',
    classification: 'Otras Comunicaciones',
    concept: 'Reunión anual de Compras',
    supplier: 'OTROS',
    calc_method: 'precio_veces',
    currency: 'MXN',
    price_index: 'precio_acordado',
    unit_price: 6000,
    months: [{ month: 12, quantity: 1 }],
    source_ref: 'Compras B-26, Gastos sin viajes!5',
    expected: 6000,
  },
  {
    area: 'Compras',
    department: 'Compras',
    category: 'Servicios Profesionales',
    classification: 'Servicios Profesionales',
    concept: 'Sin concepto en el B-26 (Gastos sin viajes!D6)',
    supplier: 'OTROS',
    calc_method: 'precio_veces',
    currency: 'MXN',
    price_index: 'precio_acordado',
    unit_price: 195000,
    months: all12(() => ({ quantity: 1 })),
    source_ref: 'Compras B-26, Gastos sin viajes!6',
    expected: 2340000,
  },
  {
    area: 'Compras',
    department: 'Compras',
    category: 'Viajes',
    classification: 'Viajes',
    concept: 'Seguimiento Paro 29 y 30 Enero',
    supplier: null,
    calc_method: 'viaje',
    currency: 'MXN',
    price_index: 'precio_acordado',
    trip: { travelers_colaborador: 1, travelers_director: 0, nights: 1 },
    months: [{ month: 1, trips: 1 }],
    source_ref: 'Compras B-26, Viajes!3',
    expected: 9500,
  },
  {
    area: 'Compras',
    department: 'Compras',
    category: 'Viajes',
    classification: 'Viajes',
    concept: 'Seguimiento Paro 4 al 6, 16 al 18 Febrero',
    supplier: null,
    calc_method: 'viaje',
    currency: 'MXN',
    price_index: 'precio_acordado',
    trip: { travelers_colaborador: 1, travelers_director: 0, nights: 4 },
    months: [{ month: 2, trips: 1 }],
    source_ref: 'Compras B-26, Viajes!4',
    expected: 21500,
  },
  {
    area: 'Compras',
    department: 'Compras',
    category: 'Viajes',
    classification: 'Viajes',
    concept: 'Cierre paro 2026',
    supplier: null,
    calc_method: 'viaje',
    currency: 'MXN',
    price_index: 'precio_acordado',
    trip: { travelers_colaborador: 2, travelers_director: 0, nights: 2 },
    months: [{ month: 3, trips: 1 }],
    source_ref: 'Compras B-26, Viajes!5',
    expected: 25500,
  },
  {
    area: 'Compras',
    department: 'Compras',
    category: 'Viajes',
    classification: 'Viajes',
    concept: 'Seguimiento',
    supplier: null,
    calc_method: 'viaje',
    currency: 'MXN',
    price_index: 'precio_acordado',
    trip: { travelers_colaborador: 2, travelers_director: 0, nights: 2 },
    months: [6, 9, 11].map((month) => ({ month, trips: 1 })),
    source_ref: 'Compras B-26, Viajes!6:8',
    expected: 76500,
  },
  {
    area: 'Planta',
    department: 'Planta',
    category: 'Servicios Administrados y Licencias',
    classification: 'Servicios Administrados y Licencias',
    concept: 'PI System',
    supplier: 'OSISOFT',
    calc_method: 'precio_veces',
    currency: 'USD',
    price_index: 'inflacion',
    unit_price: 130000,
    months: [{ month: 6, quantity: 1 }],
    source_ref: 'Planta B-26, Gasto sin viaje!23',
    expected: 2704000,
  },
  {
    area: 'Planta',
    department: 'Planta',
    category: 'Derechos y Permisos',
    classification: 'Derechos y Permisos',
    concept: 'Dictamen de Calidad de GN',
    supplier: 'SERVICES INTER LAB',
    calc_method: 'precio_veces',
    currency: 'USD',
    price_index: 'inflacion',
    unit_price: 1240.28,
    months: [3, 6, 9, 12].map((month) => ({ month, quantity: 1 })),
    source_ref: 'Planta B-26, Gasto sin viaje!30',
    expected: 103191.28,
  },
  {
    area: 'Recursos Humanos',
    department: 'Recursos Humanos',
    category: 'Beneficios',
    classification: 'Gimnasio',
    concept: 'Red de servicios de bienestar corporativo',
    supplier: 'GYMPASS',
    calc_method: 'precio_veces',
    currency: 'MXN',
    price_index: 'precio_acordado',
    unit_price: 69000,
    months: all12((m) => ({
      quantity: 1,
      unit_price: m >= 6 ? 79000 : undefined,
    })),
    source_ref: 'RH B-26, Gastos sin viajes!7',
    expected: 898000,
  },
  {
    area: 'Recursos Humanos',
    department: 'Compras',
    category: 'Capacitación',
    classification: 'Capacitación',
    concept: 'Capacitación Compras',
    supplier: 'OTROS',
    calc_method: 'precio_veces',
    currency: 'MXN',
    price_index: 'inflacion',
    unit_price: 5000,
    months: all12(() => ({ quantity: 1 })),
    source_ref: 'RH B-26, Capacitación!12',
    expected: 62400,
  },
];

/** Totales de Laura por área (suma de `expected`), para los mensajes. */
export const EXPECTED_BY_AREA =
  '$2,659,000 Compras; $2,807,191.28 Planta; $960,400 RH';

/**
 * Proveedor del catálogo de SAP por nombre: el igual (sin mayúsculas) o, si
 * no hay, el único que lo contiene. Con varios o ninguno, la línea guarda solo
 * el nombre (sin supplier_id) y la nota lo dice, para revisarlo en el dry-run
 * de prod, donde el catálogo real puede traer homónimos.
 */
async function findSupplier(
  tx: Tx,
  name: string | null,
): Promise<{ id: string | null; name: string | null; note: string | null }> {
  if (!name || name === 'OTROS') return { id: null, name, note: null };
  const select = { id: true, legal_name: true } as const;
  const exact = await tx.suppliers.findMany({
    where: {
      legal_name: { equals: name, mode: 'insensitive' },
      is_active: true,
    },
    select,
    take: 2,
  });
  const matches =
    exact.length > 0
      ? exact
      : await tx.suppliers.findMany({
          where: {
            legal_name: { contains: name, mode: 'insensitive' },
            is_active: true,
          },
          select,
          take: 5,
        });
  if (matches.length === 1) {
    return {
      id: matches[0].id,
      name: matches[0].legal_name,
      note: `${name} → ${matches[0].legal_name} (SAP)`,
    };
  }
  return {
    id: null,
    name,
    note:
      matches.length === 0
        ? `${name}: sin coincidencia en el catálogo de SAP; se guarda el nombre`
        : `${name}: ${matches.length === 5 ? '5 o más' : matches.length} coincidencias en SAP (${matches.map((m) => m.legal_name).join(' | ')}); se guarda el nombre, sin ligar`,
  };
}

export interface CargarBaseOptions {
  /** profiles.id que queda en created_by; null en prod (carga inicial). */
  createdBy: string | null;
  /** Nota de la versión B-26 si se crea (no se enseña en pantalla). */
  versionNotes: string;
  /** false = solo catálogo, versión, áreas y presupuestos, sin líneas. */
  withLines: boolean;
  /**
   * true = una línea base dada de baja se vuelve a crear (dev: restaura la
   * demo). false = se respeta la baja (prod: lo que borró el usuario no
   * regresa al volver a correr el arranque).
   */
  restoreInactiveLines: boolean;
}

export interface CargarBaseResult {
  counts: Record<string, number>;
  versionId: string;
  areaIds: Map<string, string>;
  budgetIds: Map<string, string>;
  /** Proveedores ligados o no y líneas que se respetaron dadas de baja. */
  notes: string[];
}

/** Carga (o reutiliza) el catálogo, la versión B-26, las áreas y las líneas. */
export async function cargarBase(
  tx: Tx,
  opts: CargarBaseOptions,
): Promise<CargarBaseResult> {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const notes: string[] = [];
  const createdBy = opts.createdBy;
  const named = (name: string) => ({
    equals: name,
    mode: 'insensitive' as const,
  });

  // Catálogo
  const classificationIds = new Map<string, string>();
  for (const cat of CATALOG) {
    const category =
      (await tx.fpa_categories.findFirst({
        where: { name: named(cat.name) },
      })) ??
      (bump('categorías'),
      await tx.fpa_categories.create({
        data: { name: cat.name, sort_order: cat.sort, created_by: createdBy },
      }));
    for (const [i, cls] of cat.classifications.entries()) {
      const existing = await tx.fpa_classifications.findFirst({
        where: { category_id: category.id, name: named(cls.name) },
      });
      const row =
        existing ??
        (bump('clasificaciones'),
        await tx.fpa_classifications.create({
          data: {
            category_id: category.id,
            name: cls.name,
            allows_negative: cls.allows_negative ?? false,
            sort_order: i + 1,
            created_by: createdBy,
          },
        }));
      classificationIds.set(`${cat.name}|${cls.name}`, row.id);
    }
  }

  // Versión B-26 con sus parámetros
  const version =
    (await tx.fpa_versions.findFirst({ where: { code: named('B-26') } })) ??
    (bump('versiones'),
    await tx.fpa_versions.create({
      data: {
        fiscal_year: 2026,
        kind: 'presupuesto',
        code: 'B-26',
        name: 'Presupuesto 2026',
        inflation_pct: '4.000',
        status: 'captura',
        notes: opts.versionNotes,
        created_by: createdBy,
      },
    }));
  for (const [currency, rate] of [
    ['USD', '20'],
    ['EUR', '22'],
  ] as const) {
    const exists = await tx.fpa_exchange_rates.findFirst({
      where: { version_id: version.id, currency },
    });
    if (!exists) {
      bump('tipos de cambio');
      await tx.fpa_exchange_rates.create({
        data: {
          version_id: version.id,
          currency,
          rate_mxn: rate,
          created_by: createdBy,
        },
      });
    }
  }
  const TARIFAS = [
    ['nacional', 'colaborador', 4000, 2500, 500, 1000],
    ['nacional', 'director', 9000, 2500, 500, 2000],
    ['internacional', 'colaborador', 20000, 3500, 1000, 1500],
    ['internacional', 'director', 40000, 3500, 1000, 2500],
  ] as const;
  for (const [
    trip_type,
    traveler_type,
    flight,
    hotel,
    transport,
    meals,
  ] of TARIFAS) {
    const exists = await tx.fpa_travel_rates.findFirst({
      where: { version_id: version.id, trip_type, traveler_type },
    });
    if (!exists) {
      bump('tarifas de viaje');
      await tx.fpa_travel_rates.create({
        data: {
          version_id: version.id,
          trip_type,
          traveler_type,
          flight_per_person: flight,
          hotel_per_night: hotel,
          transport_per_day: transport,
          meals_per_day: meals,
          created_by: createdBy,
        },
      });
    }
  }

  // Áreas con su departamento propio; SSGG e IT los captura RH
  const areaIds = new Map<string, string>();
  const departmentIds = new Map<string, string>();
  for (const a of AREAS) {
    let area = await tx.fpa_areas.findFirst({ where: { name: named(a.name) } });
    const isNewArea = !area;
    if (!area) {
      bump('áreas');
      area = await tx.fpa_areas.create({
        data: { name: a.name, sort_order: a.sort, created_by: createdBy },
      });
    }
    let dept = await tx.fpa_departments.findFirst({
      where: { name: named(a.name) },
    });
    if (!dept) {
      bump('departamentos');
      dept = await tx.fpa_departments.create({
        data: { name: a.name, area_id: area.id, created_by: createdBy },
      });
    }
    if (area.department_id !== dept.id) {
      // En un área nueva es parte de su alta; en una que ya existía, se cuenta
      if (!isNewArea) bump('áreas ligadas a su departamento');
      await tx.fpa_areas.update({
        where: { id: area.id },
        data: { department_id: dept.id },
      });
    }
    areaIds.set(a.name, area.id);
    departmentIds.set(a.name, dept.id);
  }
  for (const name of ['Servicios Generales', 'IT']) {
    let dept = await tx.fpa_departments.findFirst({
      where: { name: named(name) },
    });
    if (!dept) {
      bump('departamentos');
      dept = await tx.fpa_departments.create({
        data: {
          name,
          area_id: areaIds.get('Recursos Humanos'),
          created_by: createdBy,
        },
      });
    }
    departmentIds.set(name, dept.id);
  }

  // Presupuestos B-26 de cada área y sus líneas
  const budgetIds = new Map<string, string>();
  for (const a of AREAS) {
    const areaId = areaIds.get(a.name) as string;
    const budget =
      (await tx.fpa_budgets.findFirst({
        where: { version_id: version.id, area_id: areaId, is_active: true },
      })) ??
      (bump('presupuestos'),
      await tx.fpa_budgets.create({
        data: {
          version_id: version.id,
          area_id: areaId,
          created_by: createdBy,
        },
      }));
    budgetIds.set(a.name, budget.id);
  }
  // Como al abrir una versión: toda área activa lleva su presupuesto (p. ej.
  // un área que planeación dio de alta en pantalla antes de este arranque)
  const others = await tx.fpa_areas.findMany({
    where: { is_active: true, id: { notIn: [...areaIds.values()] } },
    select: { id: true, name: true },
  });
  for (const other of others) {
    const has = await tx.fpa_budgets.findFirst({
      where: { version_id: version.id, area_id: other.id, is_active: true },
      select: { id: true },
    });
    if (has) continue;
    bump('presupuestos de otras áreas');
    notes.push(
      `${other.name}: presupuesto B-26 en borrador (área ya existente)`,
    );
    await tx.fpa_budgets.create({
      data: {
        version_id: version.id,
        area_id: other.id,
        created_by: createdBy,
      },
    });
  }
  if (!opts.withLines)
    return { counts, versionId: version.id, areaIds, budgetIds, notes };

  for (const l of LINES) {
    const budgetId = budgetIds.get(l.area) as string;
    const existing = await tx.fpa_budget_lines.findMany({
      where: { budget_id: budgetId, source_ref: l.source_ref },
      select: { is_active: true },
    });
    if (existing.some((e) => e.is_active)) continue;
    if (existing.length > 0 && !opts.restoreInactiveLines) {
      notes.push(
        `${l.source_ref}: dada de baja en la plataforma; no se vuelve a crear`,
      );
      continue;
    }
    bump('líneas');
    const supplier =
      l.calc_method === 'viaje'
        ? { id: null, name: null, note: null }
        : await findSupplier(tx, l.supplier);
    if (supplier.note) notes.push(`${l.source_ref}: ${supplier.note}`);
    const key = await tx.fpa_line_keys.create({
      data: { origin: 'importacion', created_by: createdBy },
    });
    const last = await tx.fpa_budget_lines.aggregate({
      where: { budget_id: budgetId },
      _max: { sort_order: true },
    });
    const line = await tx.fpa_budget_lines.create({
      data: {
        budget_id: budgetId,
        version_id: version.id,
        line_key_id: key.id,
        sort_order: (last._max.sort_order ?? 0) + 1,
        department_id: departmentIds.get(l.department) as string,
        classification_id: classificationIds.get(
          `${l.category}|${l.classification}`,
        ) as string,
        concept: l.concept,
        supplier_id: supplier.id,
        supplier_name: supplier.name,
        calc_method: l.calc_method,
        currency: l.currency,
        price_index: l.price_index,
        unit_price: l.unit_price ?? null,
        trip_type: l.trip ? 'nacional' : null,
        travelers_colaborador: l.trip?.travelers_colaborador ?? null,
        travelers_director: l.trip?.travelers_director ?? null,
        nights: l.trip?.nights ?? null,
        car_rental: l.trip ? false : null,
        source_ref: l.source_ref,
        created_by: createdBy,
      },
    });
    await tx.fpa_budget_line_months.createMany({
      data: l.months.map((m) => ({
        line_id: line.id,
        month: m.month,
        quantity: m.quantity ?? null,
        unit_price: m.unit_price ?? null,
        amount: m.amount ?? null,
        trips: m.trips ?? null,
      })),
    });
  }
  return { counts, versionId: version.id, areaIds, budgetIds, notes };
}

/**
 * Comprueba con fpa-calc que lo guardado dé las cifras de Laura: cada línea
 * viva contra su `expected`. Una línea base dada de baja en la plataforma no
 * es un problema: va en `skipped` y no suma. Regresa los problemas, lo que se
 * saltó y el total por área.
 */
export async function verificarBase(
  tx: Tx,
  versionId: string,
  budgetIds: Map<string, string>,
): Promise<{
  problems: string[];
  skipped: string[];
  byArea: Map<string, Prisma.Decimal>;
}> {
  const version = await tx.fpa_versions.findUniqueOrThrow({
    where: { id: versionId },
    include: {
      fpa_exchange_rates: { where: { is_active: true } },
      fpa_travel_rates: { where: { is_active: true } },
    },
  });
  const params = {
    inflation_pct: version.inflation_pct,
    cutoff_month: version.cutoff_month,
    rates: Object.fromEntries(
      version.fpa_exchange_rates.map((r) => [r.currency, r.rate_mxn]),
    ),
    travel_rates: version.fpa_travel_rates,
  };
  const problems: string[] = [];
  const skipped: string[] = [];
  const byArea = new Map<string, Prisma.Decimal>();
  for (const l of LINES) {
    const line = await tx.fpa_budget_lines.findFirst({
      where: {
        budget_id: budgetIds.get(l.area),
        source_ref: l.source_ref,
        is_active: true,
      },
      include: { fpa_budget_line_months: true },
    });
    if (!line) {
      const inactive = await tx.fpa_budget_lines.findFirst({
        where: { budget_id: budgetIds.get(l.area), source_ref: l.source_ref },
        select: { id: true },
      });
      if (inactive) skipped.push(l.source_ref);
      else problems.push(`falta la línea ${l.source_ref}`);
      continue;
    }
    const r = calcLine(
      { ...line, months: line.fpa_budget_line_months },
      params,
    );
    const got = r.total_mxn?.toFixed(2) ?? 'No disponible';
    if (got !== l.expected.toFixed(2)) {
      problems.push(
        `${l.source_ref}: da ${got}, Laura ${l.expected.toFixed(2)}`,
      );
    }
    if (r.total_mxn) {
      const prev = byArea.get(l.area) ?? new Prisma.Decimal(0);
      byArea.set(l.area, prev.plus(r.total_mxn));
    }
  }
  return { problems, skipped, byArea };
}

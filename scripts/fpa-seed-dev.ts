/**
 * FP&A (A3, demo del lunes 26-oct) — datos de ejemplo SOLO PARA DEV.
 *
 * Carga lo que hace falta para enseñar el módulo con cifras reales de los
 * Excel de Laura (documentation/FPA.md, "Formato único de captura", y
 * documentation/fpa/0021_fpa_pruebas.sql):
 *   - catálogo base de categorías y clasificaciones (orden del reporte);
 *   - la versión B-26 en captura, con inflación 4%, USD 20 / EUR 22 y las
 *     tarifas de viaje de la hoja '2';
 *   - áreas Compras, Planta y Recursos Humanos, cada una con su departamento
 *     propio, y los departamentos SSGG e IT que captura RH;
 *   - el B-26 completo de Compras (8 líneas = $2,659,000, Resumen!H11), PI
 *     System e INTER LAB de Planta, y Gympass y una capacitación de RH;
 *   - usuarios de prueba con login local, uno por papel: captura y aprobación
 *     de Compras (fpa_area), planeación (fpa_planeacion) y CFO (fpa_cfo).
 *
 * Idempotente: lo que ya existe se reutiliza y nada se borra (la app no tiene
 * DELETE en las tablas fpa_). Las líneas se reconocen por su source_ref.
 *
 * USO (por omisión DRY-RUN: corre todo en una transacción y la deshace):
 *   npm run fpa:seed-dev
 *   npm run fpa:seed-dev -- --commit
 * Contraseña de los usuarios de prueba: se fija solo al crear cada usuario,
 * con FPA_SEED_PASSWORD o una generada que se imprime UNA vez (solo dev; nunca
 * la dejes en documentos). Para cambiarla en usuarios que ya existen:
 *   FPA_SEED_PASSWORD=<nueva> npm run fpa:seed-dev -- --commit --reset-passwords
 *
 * Al final comprueba, línea por línea y con fpa-calc, que lo guardado dé las
 * cifras de Laura.
 *
 * GUARDAS: no corre con NODE_ENV=production y solo escribe en la base de dev:
 * exige una fila que solo trae el seed de dev (0003_seed_data.sql) y que prod
 * no tiene (prod arrancó sin 0003). Los scripts de prod se corren desde un
 * contenedor efímero con NODE_ENV=development, así que la primera guarda sola
 * no basta.
 */
import 'dotenv/config';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { calcLine } from '../src/fpa/fpa-calc';

const COMMIT = process.argv.includes('--commit');
const RESET_PASSWORDS = process.argv.includes('--reset-passwords');

/** departments 'Compras' del seed de dev (0003_seed_data.sql:26); prod no la tiene. */
const DEV_MARKER_DEPARTMENT = '0ef8feda-5f93-40d2-9c9a-91203cb5316f';

class DryRunRollback extends Error {}

type Tx = Prisma.TransactionClient;

const CATALOG: Array<{
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

const AREAS = [
  { name: 'Compras', sort: 1 },
  { name: 'Planta', sort: 2 },
  { name: 'Recursos Humanos', sort: 3 },
];

const TEST_USERS = [
  {
    key: 'captura',
    email: 'fpa.captura.compras@abent3t.com',
    name: 'Captura Compras (prueba FP&A)',
    role: 'fpa_area',
    duty: 'captura',
    area: 'Compras',
  },
  {
    key: 'aprobacion',
    email: 'fpa.aprueba.compras@abent3t.com',
    name: 'Aprueba Compras (prueba FP&A)',
    role: 'fpa_area',
    duty: 'aprobacion',
    area: 'Compras',
  },
  {
    key: 'planeacion',
    email: 'fpa.planeacion@abent3t.com',
    name: 'Planeación (prueba FP&A)',
    role: 'fpa_planeacion',
    duty: null,
    area: null,
  },
  {
    key: 'cfo',
    email: 'fpa.cfo@abent3t.com',
    name: 'CFO (prueba FP&A)',
    role: 'fpa_cfo',
    duty: null,
    area: null,
  },
] as const;

interface SeedLine {
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

const LINES: SeedLine[] = [
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

const log = (msg: string) => console.log(msg);

async function findSupplier(tx: Tx, name: string | null) {
  if (!name || name === 'OTROS') return { id: null, name: name ?? null };
  const found = await tx.suppliers.findFirst({
    where: {
      legal_name: { contains: name, mode: 'insensitive' },
      is_active: true,
    },
    select: { id: true, legal_name: true },
    orderBy: { legal_name: 'asc' },
  });
  return found ? { id: found.id, name: found.legal_name } : { id: null, name };
}

async function seed(tx: Tx, password: string) {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  // Catálogo
  const classificationIds = new Map<string, string>();
  for (const cat of CATALOG) {
    const category =
      (await tx.fpa_categories.findFirst({ where: { name: cat.name } })) ??
      (bump('categorías'),
      await tx.fpa_categories.create({
        data: { name: cat.name, sort_order: cat.sort },
      }));
    for (const [i, cls] of cat.classifications.entries()) {
      const existing = await tx.fpa_classifications.findFirst({
        where: { category_id: category.id, name: cls.name },
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
          },
        }));
      classificationIds.set(`${cat.name}|${cls.name}`, row.id);
    }
  }

  // Versión B-26 con sus parámetros
  const version =
    (await tx.fpa_versions.findFirst({ where: { code: 'B-26' } })) ??
    (bump('versiones'),
    await tx.fpa_versions.create({
      data: {
        fiscal_year: 2026,
        kind: 'presupuesto',
        code: 'B-26',
        name: 'Presupuesto 2026',
        inflation_pct: '4.000',
        status: 'captura',
        notes:
          'Datos de ejemplo de dev (fpa-seed-dev): cifras de los Excel de Laura.',
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
        data: { version_id: version.id, currency, rate_mxn: rate },
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
        },
      });
    }
  }

  // Áreas con su departamento propio; SSGG e IT los captura RH
  const areaIds = new Map<string, string>();
  const departmentIds = new Map<string, string>();
  for (const a of AREAS) {
    let area = await tx.fpa_areas.findFirst({ where: { name: a.name } });
    if (!area) {
      bump('áreas');
      area = await tx.fpa_areas.create({
        data: { name: a.name, sort_order: a.sort },
      });
    }
    let dept = await tx.fpa_departments.findFirst({ where: { name: a.name } });
    if (!dept) {
      bump('departamentos');
      dept = await tx.fpa_departments.create({
        data: { name: a.name, area_id: area.id },
      });
    }
    if (area.department_id !== dept.id) {
      await tx.fpa_areas.update({
        where: { id: area.id },
        data: { department_id: dept.id },
      });
    }
    areaIds.set(a.name, area.id);
    departmentIds.set(a.name, dept.id);
  }
  for (const name of ['Servicios Generales', 'IT']) {
    let dept = await tx.fpa_departments.findFirst({ where: { name } });
    if (!dept) {
      bump('departamentos');
      dept = await tx.fpa_departments.create({
        data: { name, area_id: areaIds.get('Recursos Humanos') },
      });
    }
    departmentIds.set(name, dept.id);
  }

  // Usuarios de prueba (login local de dev) con su rol fpa y su responsabilidad
  const hash = await bcrypt.hash(password, 10);
  const people: Record<string, string> = {};
  for (const u of TEST_USERS) {
    let profile = await tx.profiles.findUnique({ where: { email: u.email } });
    if (!profile) {
      bump('usuarios de prueba');
      profile = await tx.profiles.create({
        data: { email: u.email, full_name: u.name, pending_first_login: false },
      });
    }
    people[u.key] = profile.id;
    // La contraseña se fija al crear la credencial; con --reset-passwords se
    // reemplaza (así otra corrida no invalida la que ya se compartió)
    const credential = await tx.local_credentials.findUnique({
      where: { profile_id: profile.id },
      select: { profile_id: true },
    });
    if (!credential) {
      bump('contraseñas fijadas');
      await tx.local_credentials.create({
        data: {
          profile_id: profile.id,
          password_hash: hash,
          must_change_password: false,
        },
      });
    } else if (RESET_PASSWORDS) {
      bump('contraseñas fijadas');
      await tx.local_credentials.update({
        where: { profile_id: profile.id },
        data: {
          password_hash: hash,
          password_set_at: new Date(),
          must_change_password: false,
          is_active: true,
          failed_attempts: 0,
          locked_until: null,
        },
      });
    }
    const role = await tx.user_roles.findFirst({
      where: { profile_id: profile.id, module: 'fpa', role: u.role },
    });
    if (!role) {
      bump('roles fpa');
      await tx.user_roles.create({
        data: { profile_id: profile.id, module: 'fpa', role: u.role },
      });
    } else if (!role.is_active) {
      await tx.user_roles.update({
        where: { id: role.id },
        data: { is_active: true, revoked_at: null, revoked_by: null },
      });
    }
    if (u.duty && u.area) {
      const areaId = areaIds.get(u.area) as string;
      const exists = await tx.fpa_assignments.findFirst({
        where: {
          area_id: areaId,
          duty: u.duty,
          profile_id: profile.id,
          is_active: true,
        },
      });
      const titular = await tx.fpa_assignments.findFirst({
        where: {
          area_id: areaId,
          duty: u.duty,
          is_active: true,
          is_alternate: false,
        },
      });
      if (!exists && !titular) {
        bump('responsabilidades');
        await tx.fpa_assignments.create({
          data: { area_id: areaId, duty: u.duty, profile_id: profile.id },
        });
      } else if (!exists && titular) {
        log(`  (el área ${u.area} ya tiene titular de ${u.duty}: no se toca)`);
      }
    }
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
          created_by: people.planeacion,
        },
      }));
    budgetIds.set(a.name, budget.id);
  }
  for (const l of LINES) {
    const budgetId = budgetIds.get(l.area) as string;
    const exists = await tx.fpa_budget_lines.findFirst({
      where: { budget_id: budgetId, source_ref: l.source_ref, is_active: true },
      select: { id: true },
    });
    if (exists) continue;
    bump('líneas');
    const supplier = await findSupplier(tx, l.supplier);
    const key = await tx.fpa_line_keys.create({
      data: { origin: 'importacion', created_by: people.planeacion },
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
        supplier_id: l.calc_method === 'viaje' ? null : supplier.id,
        supplier_name: l.calc_method === 'viaje' ? null : supplier.name,
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
        created_by: people.planeacion,
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
  return { counts, versionId: version.id, budgetIds };
}

/**
 * Comprueba con fpa-calc que lo guardado dé las cifras de Laura: cada línea
 * contra su `expected` y el total por área.
 */
async function verify(
  tx: Tx,
  versionId: string,
  budgetIds: Map<string, string>,
): Promise<string[]> {
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
      problems.push(`falta la línea ${l.source_ref}`);
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
  for (const [area, total] of byArea) log(`  = ${area}: ${total.toFixed(2)}`);
  return problems;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Guardia: fpa-seed-dev no corre con NODE_ENV=production (son datos de ejemplo).',
    );
  }
  const generated = !process.env.FPA_SEED_PASSWORD;
  const password =
    process.env.FPA_SEED_PASSWORD ?? randomBytes(9).toString('base64url');

  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const devMarker = await prisma.departments.findUnique({
      where: { id: DEV_MARKER_DEPARTMENT },
      select: { id: true },
    });
    if (!devMarker) {
      throw new Error(
        'Guardia: esta base no es la de dev (no trae el seed de dev). fpa-seed-dev no escribe aquí.',
      );
    }
    log(
      COMMIT
        ? 'Modo COMMIT: se escriben los datos de ejemplo.'
        : 'Modo DRY-RUN: se corre todo y se deshace (agrega --commit para escribir).',
    );
    let result: Awaited<ReturnType<typeof seed>> | null = null;
    let problems: string[] = [];
    try {
      await prisma.$transaction(
        async (tx) => {
          const seeded = await seed(tx, password);
          result = seeded;
          problems = await verify(tx, seeded.versionId, seeded.budgetIds);
          if (!COMMIT) throw new DryRunRollback();
        },
        { timeout: 120_000, maxWait: 20_000 },
      );
    } catch (e) {
      if (!(e instanceof DryRunRollback)) throw e;
    }
    const r = result as Awaited<ReturnType<typeof seed>> | null;
    if (!r) throw new Error('No se generó el plan');
    const entries = Object.entries(r.counts);
    log(
      entries.length
        ? `${COMMIT ? 'Creado' : 'Se crearía'}:`
        : 'Nada nuevo: los datos de ejemplo ya estaban.',
    );
    for (const [k, n] of entries) log(`  - ${k}: ${n}`);
    for (const u of TEST_USERS)
      log(
        `  · ${u.email} — ${u.role}${u.duty ? ` (${u.duty} de ${u.area})` : ''}`,
      );
    if (COMMIT && r.counts['contraseñas fijadas']) {
      log(
        generated
          ? `Contraseña de los usuarios de prueba (se muestra una sola vez): ${password}`
          : 'Contraseña de los usuarios de prueba: la de FPA_SEED_PASSWORD.',
      );
    }
    if (problems.length > 0) {
      log('Las cifras NO cuadran con Laura:');
      for (const p of problems) log(`  ✗ ${p}`);
      process.exitCode = 1;
    } else {
      log(
        'Cifras de Laura comprobadas con fpa-calc: Compras $2,659,000; Planta $2,807,191.28; RH $960,400.',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
});

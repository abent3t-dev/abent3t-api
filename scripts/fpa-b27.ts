/**
 * FP&A (bloque C, C3) — carga el presupuesto 2027 de Laura en la versión
 * B-27 (documentation/TAREAS_FPA_2026-11-04.md, C3; lo acordado el 4-nov: va
 * primero el 2027 y lo cargamos nosotros).
 *
 * Lee scripts/data/fpa-b27.json, que genera `fpa:b27-leer` con los Excel de
 * Laura, y:
 *   1. crea la versión B-27 en PREPARACIÓN (las áreas no la ven hasta que
 *      planeación la revise, David dé el visto bueno y la abra), con la
 *      inflación y el dólar de las fórmulas del archivo y las tarifas de viaje
 *      del B-26 hasta tener la política vigente. Si ya existe en preparación y
 *      sin líneas de otra carga, la usa (no le cambia lo que ya tenga);
 *   2. el presupuesto de cada área que trae líneas, en borrador;
 *   3. las líneas, como monto por mes, con la categoría y clasificación del
 *      COA. Lo que no tiene clasificación del COA va a "Por clasificar" (dada
 *      de baja, para que al editarla haya que elegir otra) y se lista;
 *   4. liga el proveedor al catálogo de SAP si el texto coincide con uno solo
 *      (igual, o un nombre que empieza con él); si no, OTROS.
 *
 * Cuadre: el total de cada área en la base (fpa-calc) debe dar lo que calculó
 * el lector. Las diferencias contra el archivo que el lector explicó (sus
 * sumas que no suman todo) piden --aceptar-diferencias; si hay alguna sin
 * explicar, no carga. Nunca toca la B-26 ni otra versión.
 *
 * Idempotente: una línea ya cargada (mismo presupuesto y source_ref) no se
 * repite, y una que alguien dio de baja no se vuelve a crear.
 *
 * USO (por omisión, modo de prueba: corre todo en una transacción y la deshace):
 *   npm run fpa:b27
 *   npm run fpa:b27 -- --aceptar-diferencias --commit
 *   opciones: --archivo <ruta.json>  --codigo <clave, por omisión B-27>
 *
 * Requiere fpa:catalogo y fpa:areas. Se niega a correr con NODE_ENV=production:
 * en prod se corre desde un contenedor efímero, como fpa:arranque.
 */
import 'dotenv/config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '@prisma/client';
import { calcLine } from '../src/fpa/fpa-calc';
import { clave } from '../src/fpa/carga/normalizar';
import {
  POR_CLASIFICAR,
  type ArchivoB27,
  type LineaB27,
} from '../src/fpa/carga/plantilla';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  COMMIT,
  compararTotales,
  enTransaccion,
  guardiaProduccion,
  log,
  nombrado,
  opcion,
  totalesPorVersion,
  type Tx,
} from './fpa-comun';

const ACEPTAR = process.argv.includes('--aceptar-diferencias');
const ARCHIVO = opcion('--archivo') ?? join(__dirname, 'data', 'fpa-b27.json');
const CODIGO = opcion('--codigo') ?? 'B-27';

export interface DatosB27 {
  generado: string;
  fuente: Array<{ archivo: string; md5: string; hoja: string }>;
  parametros: { inflacion_pct: string | null; usd: string | null };
  archivos: ArchivoB27[];
  avisos: string[];
  problemas: string[];
}

interface PorArea {
  area: string;
  archivo: string;
  lineas: string;
  base: string;
  diferencia: string;
  /** Las referencias de la sección, para el cuadre. */
  refs: string[];
  /** total en pesos de cada referencia, según el lector. */
  totales: Map<string, string>;
}

interface Resultado {
  problemas: string[];
  avisos: string[];
  cuenta: Record<string, number>;
  version: string;
  porArea: PorArea[];
  proveedores: string[];
  porClasificar: string[];
}

/** Proveedor del catálogo de SAP: el igual o el único que empieza con el texto. */
async function proveedor(
  tx: Tx,
  texto: string,
  noEs: string[],
): Promise<{ id: string; nombre: string } | null> {
  const t = texto.trim();
  if (t.length < 4 || noEs.some((x) => clave(x) === clave(t))) return null;
  const select = { id: true, legal_name: true } as const;
  const iguales = await tx.suppliers.findMany({
    where: { legal_name: { equals: t, mode: 'insensitive' }, is_active: true },
    select,
    take: 2,
  });
  const candidatos =
    iguales.length > 0
      ? iguales
      : await tx.suppliers.findMany({
          where: {
            legal_name: { startsWith: t, mode: 'insensitive' },
            is_active: true,
          },
          select,
          take: 2,
        });
  return candidatos.length === 1
    ? { id: candidatos[0].id, nombre: candidatos[0].legal_name }
    : null;
}

export async function cargarB27(
  tx: Tx,
  datos: DatosB27,
  codigo = CODIGO,
): Promise<Resultado> {
  const problemas: string[] = [];
  const avisos: string[] = [];
  const cuenta: Record<string, number> = {};
  const sumar = (k: string, n = 1) => (cuenta[k] = (cuenta[k] ?? 0) + n);
  const proveedores: string[] = [];
  const porClasificar: string[] = [];
  const antes = await totalesPorVersion(tx);
  const secciones = datos.archivos
    .flatMap((a) => a.secciones)
    .filter((s) => s.lineas.length > 0);
  const refs = new Set(secciones.flatMap((s) => s.lineas.map((l) => l.ref)));

  // Áreas, departamentos y catálogo (los dejan fpa:areas y fpa:catalogo)
  const areas = await tx.fpa_areas.findMany({ where: { is_active: true } });
  const deptos = await tx.fpa_departments.findMany({
    where: { is_active: true },
  });
  const areaId = new Map<string, string>();
  for (const s of secciones) {
    const a = areas.find((x) => clave(x.name) === clave(s.area));
    if (a) areaId.set(s.area, a.id);
    else problemas.push(`no existe el área ${s.area}: corre antes fpa:areas`);
  }
  const deptoId = (nombre: string) =>
    deptos.find((d) => clave(d.name) === clave(nombre))?.id;
  for (const nombre of new Set(
    secciones.flatMap((s) => s.lineas.map((l) => l.departamento)),
  )) {
    if (!deptoId(nombre))
      problemas.push(
        `no existe el departamento ${nombre}: corre antes fpa:catalogo`,
      );
  }
  const categorias = await tx.fpa_categories.findMany({
    include: { fpa_classifications: true },
  });
  const clasificacion = new Map<
    string,
    { id: string; allows_negative: boolean }
  >();
  const pares = new Set(
    secciones.flatMap((s) =>
      s.lineas.map((l) => `${l.categoria}|${l.clasificacion}`),
    ),
  );
  for (const par of pares) {
    const [cat, cls] = par.split('|');
    let categoria = categorias.find(
      (c) =>
        clave(c.name) === clave(cat) && (c.is_active || cat === POR_CLASIFICAR),
    );
    if (!categoria && cat === POR_CLASIFICAR) {
      const creada = await tx.fpa_categories.create({
        data: { name: POR_CLASIFICAR, sort_order: 999, is_active: false },
      });
      categoria = { ...creada, fpa_classifications: [] };
      categorias.push(categoria);
      sumar('categoría Por clasificar (dada de baja)');
    }
    if (!categoria) {
      problemas.push(
        `falta la categoría ${cat} en el catálogo: corre antes fpa:catalogo`,
      );
      continue;
    }
    let k = categoria.fpa_classifications.find(
      (x) =>
        clave(x.name) === clave(cls) && (x.is_active || cls === POR_CLASIFICAR),
    );
    if (!k && cls === POR_CLASIFICAR) {
      // Dada de baja: se ve en la línea, pero para guardarla hay que elegir otra
      k = await tx.fpa_classifications.create({
        data: {
          category_id: categoria.id,
          name: POR_CLASIFICAR,
          allows_negative: true,
          sort_order: 999,
          is_active: false,
        },
      });
      categoria.fpa_classifications.push(k);
      sumar('clasificaciones Por clasificar (dadas de baja)');
    }
    if (!k) {
      problemas.push(
        `falta la clasificación ${cat} › ${cls}: corre antes fpa:catalogo`,
      );
      continue;
    }
    clasificacion.set(par, { id: k.id, allows_negative: k.allows_negative });
  }
  for (const s of secciones) {
    for (const l of s.lineas) {
      const k = clasificacion.get(`${l.categoria}|${l.clasificacion}`);
      if (k && !k.allows_negative && l.meses.some((m) => Number(m.monto) < 0)) {
        problemas.push(
          `${s.area}, ${l.ref}: monto negativo en ${l.categoria} › ${l.clasificacion}, que no acepta negativos`,
        );
      }
    }
  }
  if (problemas.length > 0) {
    return {
      problemas,
      avisos,
      cuenta,
      version: codigo,
      porArea: [],
      proveedores,
      porClasificar,
    };
  }

  // 1. La versión: nueva en preparación, o la que ya existe si se puede usar
  const { inflacion_pct, usd } = datos.parametros;
  const fuente =
    `Archivos de Laura (${datos.fuente.length}): inflación ${inflacion_pct ?? '—'}%, USD ${usd ?? '—'}; tarifas de viaje del B-26 por confirmar`.slice(
      0,
      200,
    );
  const b26 = await tx.fpa_versions.findFirst({
    where: { code: nombrado('B-26') },
    include: { fpa_travel_rates: { where: { is_active: true } } },
  });
  let version = await tx.fpa_versions.findFirst({
    where: { code: nombrado(codigo) },
  });
  if (!version) {
    version = await tx.fpa_versions.create({
      data: {
        fiscal_year: 2027,
        kind: 'presupuesto',
        code: codigo,
        name: 'Presupuesto 2027',
        inflation_pct: inflacion_pct,
        status: 'preparacion',
        params_source: fuente,
        params_updated_at: new Date(),
        notes:
          `Cargada con fpa:b27 el ${new Date().toISOString().slice(0, 10)} desde ${datos.fuente.map((f) => f.archivo).join(', ')}`.slice(
            0,
            2000,
          ),
      },
    });
    sumar('versión');
  } else {
    if (version.status !== 'preparacion' || !version.is_active) {
      problemas.push(
        `la versión ${version.code} está en ${version.status}${version.is_active ? '' : ' (dada de baja)'}: no se toca; usa --codigo con otra clave`,
      );
    }
    const otras = await tx.fpa_budget_lines.count({
      where: {
        version_id: version.id,
        is_active: true,
        NOT: { source_ref: { in: [...refs] } },
      },
    });
    if (otras > 0) {
      problemas.push(
        `la versión ${version.code} ya tiene ${otras} línea(s) que no son de esta carga: usa --codigo con otra clave`,
      );
    }
    const inflacionActual = version.inflation_pct?.toFixed(3) ?? null;
    if (inflacionActual && inflacion_pct && inflacionActual !== inflacion_pct) {
      problemas.push(
        `la versión ${version.code} tiene inflación ${inflacionActual}% y el archivo ${inflacion_pct}%`,
      );
    } else if (!inflacionActual && inflacion_pct) {
      if (version.params_approved_at)
        problemas.push(
          `la versión ${version.code} tiene visto bueno: no se le cambian parámetros`,
        );
      await tx.fpa_versions.update({
        where: { id: version.id },
        data: {
          inflation_pct: inflacion_pct,
          params_updated_at: new Date(),
          params_updated_by: null,
        },
      });
      sumar('parámetros puestos en la versión');
    }
    avisos.push(
      `La versión ${version.code} ya existía (${version.status}); se usa sin cambiar sus otros datos`,
    );
  }
  if (usd) {
    const tc = await tx.fpa_exchange_rates.findFirst({
      where: { version_id: version.id, currency: 'USD' },
    });
    if (!tc) {
      await tx.fpa_exchange_rates.create({
        data: { version_id: version.id, currency: 'USD', rate_mxn: usd },
      });
      sumar('tipos de cambio');
    } else if (!tc.is_active || !tc.rate_mxn.equals(usd)) {
      problemas.push(
        `la versión ${version.code} tiene USD ${tc.rate_mxn.toFixed(2)}${tc.is_active ? '' : ' (dado de baja)'} y el archivo ${usd}`,
      );
    }
  }
  const tarifas = await tx.fpa_travel_rates.count({
    where: { version_id: version.id },
  });
  if (tarifas === 0 && b26 && b26.fpa_travel_rates.length > 0) {
    await tx.fpa_travel_rates.createMany({
      data: b26.fpa_travel_rates.map((t) => ({
        version_id: version.id,
        trip_type: t.trip_type,
        traveler_type: t.traveler_type,
        flight_per_person: t.flight_per_person,
        hotel_per_night: t.hotel_per_night,
        transport_per_day: t.transport_per_day,
        meals_per_day: t.meals_per_day,
      })),
    });
    sumar('tarifas de viaje (copiadas del B-26)', b26.fpa_travel_rates.length);
  }
  if (problemas.length > 0) {
    return {
      problemas,
      avisos,
      cuenta,
      version: version.code,
      porArea: [],
      proveedores,
      porClasificar,
    };
  }

  // 2 y 3. Presupuesto de cada área y sus líneas
  const porArea: Resultado['porArea'] = [];
  for (const s of secciones) {
    const area = areaId.get(s.area) as string;
    const budget =
      (await tx.fpa_budgets.findFirst({
        where: { version_id: version.id, area_id: area, is_active: true },
      })) ??
      (sumar('presupuestos en borrador'),
      await tx.fpa_budgets.create({
        data: { version_id: version.id, area_id: area },
      }));
    let orden =
      (
        await tx.fpa_budget_lines.aggregate({
          where: { budget_id: budget.id },
          _max: { sort_order: true },
        })
      )._max.sort_order ?? 0;
    for (const l of s.lineas) {
      const previas = await tx.fpa_budget_lines.findMany({
        where: { budget_id: budget.id, source_ref: l.ref },
        select: { is_active: true },
      });
      if (previas.some((p) => p.is_active)) continue;
      if (previas.length > 0) {
        avisos.push(
          `${l.ref}: dada de baja en la plataforma; no se vuelve a crear`,
        );
        continue;
      }
      const sap = await proveedor(tx, l.proveedor, [
        l.categoria,
        l.clasificacion,
      ]);
      if (sap) proveedores.push(`${l.proveedor} → ${sap.nombre}`);
      if (l.clasificacion === POR_CLASIFICAR) {
        porClasificar.push(
          `${s.area}: "${l.concepto}" (${l.total}) › ${l.categoria} › Por clasificar`,
        );
      }
      const key = await tx.fpa_line_keys.create({
        data: { origin: 'importacion' },
      });
      orden += 1;
      const linea = await tx.fpa_budget_lines.create({
        data: {
          budget_id: budget.id,
          version_id: version.id,
          line_key_id: key.id,
          sort_order: orden,
          department_id: deptoId(l.departamento) as string,
          classification_id: (
            clasificacion.get(`${l.categoria}|${l.clasificacion}`) as {
              id: string;
            }
          ).id,
          concept: l.concepto,
          justification: justificacion(l),
          supplier_id: sap?.id ?? null,
          supplier_name: sap?.nombre ?? 'OTROS',
          priority: l.prioridad,
          calc_method: 'monto_mes',
          currency: l.moneda,
          price_index: l.indice,
          source_ref: l.ref,
        },
      });
      await tx.fpa_budget_line_months.createMany({
        data: l.meses.map((m) => ({
          line_id: linea.id,
          month: m.mes,
          amount: m.monto,
        })),
      });
      sumar('líneas');
    }
    porArea.push({
      area: s.area,
      archivo: s.total_archivo,
      lineas: s.total_lineas,
      base: '',
      diferencia: s.diferencia,
      refs: s.lineas.map((l) => l.ref),
      totales: new Map(s.lineas.map((l) => [l.ref, l.total])),
    });
  }

  // Cuadre: lo que quedó en la base contra lo que calculó el lector
  const params = await tx.fpa_versions.findUniqueOrThrow({
    where: { id: version.id },
    include: {
      fpa_exchange_rates: { where: { is_active: true } },
      fpa_travel_rates: { where: { is_active: true } },
    },
  });
  const calc = {
    inflation_pct: params.inflation_pct,
    cutoff_month: params.cutoff_month,
    rates: Object.fromEntries(
      params.fpa_exchange_rates.map((r) => [r.currency, r.rate_mxn]),
    ),
    travel_rates: params.fpa_travel_rates,
  };
  for (const fila of porArea) {
    const lineas = await tx.fpa_budget_lines.findMany({
      where: {
        version_id: version.id,
        is_active: true,
        source_ref: { in: fila.refs },
        fpa_budgets: { area_id: areaId.get(fila.area) },
      },
      include: { fpa_budget_line_months: true },
    });
    let total = new Prisma.Decimal(0);
    let esperado = new Prisma.Decimal(0);
    for (const l of lineas) {
      const r = calcLine({ ...l, months: l.fpa_budget_line_months }, calc);
      if (r.total_mxn) total = total.plus(r.total_mxn);
      else
        problemas.push(
          `${l.source_ref}: sale "No disponible" (${r.unavailable_reason ?? 'falta un parámetro'})`,
        );
      // Lo dado de baja en la plataforma no está aquí ni cuenta del lado del lector
      esperado = esperado.plus(fila.totales.get(l.source_ref ?? '') ?? '0');
    }
    fila.base = total.toFixed(2);
    const faltan = fila.refs.length - lineas.length;
    if (!total.equals(esperado)) {
      problemas.push(
        `${fila.area}: en la base da ${total.toFixed(2)} y el lector calculó ${esperado.toFixed(2)}`,
      );
    }
    if (faltan > 0)
      avisos.push(
        `${fila.area}: ${faltan} línea(s) del archivo no están vivas (dadas de baja en la plataforma)`,
      );
  }
  problemas.push(
    ...compararTotales(antes, await totalesPorVersion(tx), [version.code]),
  );
  return {
    problemas,
    avisos,
    cuenta,
    version: version.code,
    porArea,
    proveedores,
    porClasificar,
  };
}

/** El comentario del archivo y, si es un supuesto, por qué quedó así. */
function justificacion(l: LineaB27): string | null {
  const partes: string[] = [];
  if (l.justificacion) partes.push(l.justificacion);
  if (
    ['por_clasificar', 'fuera_del_coa', 'alias', 'beneficiario'].includes(
      l.como,
    ) &&
    l.notas.length
  ) {
    partes.push(`[Carga del B-27] ${l.notas.join('; ')}`);
  }
  return partes.length ? partes.join('\n') : null;
}

async function main() {
  guardiaProduccion('fpa-b27');
  if (!existsSync(ARCHIVO)) {
    throw new Error(
      `No está ${ARCHIVO}. Primero: npm run fpa:b27-leer -- "<carpeta con los Excel de Laura>" (o --archivo <ruta.json>)`,
    );
  }
  const datos = JSON.parse(readFileSync(ARCHIVO, 'utf8')) as DatosB27;
  log(
    COMMIT
      ? `Modo COMMIT: se carga el presupuesto 2027 en ${CODIGO}.`
      : `Modo de prueba: se corre todo y se deshace (agrega --commit para escribir).`,
  );
  log(
    `Archivos (${datos.generado.slice(0, 10)}): ${datos.fuente.map((f) => `${f.archivo} [md5 ${f.md5.slice(0, 8)}]`).join('; ')}`,
  );
  if (datos.problemas.length > 0) {
    log('El lector dejó problemas; no se carga nada:');
    for (const p of datos.problemas) log(`  ✗ ${p}`);
    process.exitCode = 1;
    return;
  }
  const secciones = datos.archivos.flatMap((a) => a.secciones);
  const sinExplicar = secciones.filter(
    (s) => s.tipo_diferencia === 'sin_explicar',
  );
  const explicadas = secciones.filter((s) => s.tipo_diferencia === 'explicada');
  if (sinExplicar.length > 0) {
    log(
      `Hay diferencias sin explicar contra el archivo (${sinExplicar.map((s) => s.area).join(', ')}): no se carga.`,
    );
    process.exitCode = 1;
    return;
  }
  if (explicadas.length > 0) {
    log('Diferencias contra el archivo, explicadas por el lector:');
    for (const d of datos.archivos.flatMap((a) => a.diferencias)) {
      log(
        `  ≠ ${d.area}, fila ${d.fila} "${d.etiqueta}": ${d.diferencia}. ${d.motivo}`,
      );
    }
    if (!ACEPTAR) {
      log('  (para cargar con ellas: --aceptar-diferencias)');
      if (COMMIT) {
        process.exitCode = 1;
        return;
      }
    }
  }
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const { resultado: r, escrito } = await enTransaccion(prisma, (tx) =>
      cargarB27(tx, datos),
    );
    const entradas = Object.entries(r.cuenta);
    log(
      entradas.length
        ? `${escrito ? 'Hecho' : 'Se haría'} en ${r.version}:`
        : `Nada nuevo: ${r.version} ya tenía esta carga.`,
    );
    for (const [k, n] of entradas) log(`  - ${k}: ${n}`);
    if (r.porArea.length > 0) {
      log('Por área (archivo · líneas · en la base):');
      for (const a of r.porArea) {
        log(
          `  = ${a.area}: ${a.archivo} · ${a.lineas} · ${a.base}${Number(a.diferencia) !== 0 ? ` (contra el archivo: ${a.diferencia})` : ''}`,
        );
      }
    }
    if (r.porClasificar.length > 0) {
      log(
        `Por clasificar (${r.porClasificar.length}; para decidir con Laura):`,
      );
      for (const p of r.porClasificar) log(`  · ${p}`);
    }
    if (r.proveedores.length > 0) {
      log(
        `Proveedores ligados al catálogo de SAP (${r.proveedores.length}; los demás, OTROS):`,
      );
      for (const p of r.proveedores) log(`  · ${p}`);
    }
    for (const a of [...datos.avisos, ...r.avisos]) log(`  · ${a}`);
    if (r.problemas.length > 0) {
      log(`NO cuadra${COMMIT ? ': no se escribió nada' : ''}.`);
      for (const p of r.problemas) log(`  ✗ ${p}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module)
  main().catch((err) => {
    console.error('❌', err instanceof Error ? err.message : err);
    process.exit(1);
  });

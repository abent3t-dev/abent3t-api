/**
 * FP&A (bloque C, C1) — carga el catálogo del Chart of Accounts de A3T
 * (documentation/TAREAS_FPA_2026-11-04.md, C1, y FPA.md, "Bloque C").
 *
 * Lee scripts/data/fpa-coa.json (lo genera `fpa:coa-leer` desde el Excel) y:
 *   1. da de alta los 17 departamentos del COA con su centro de costos
 *      (GSGAD001…, NAES y GE), o le pone el centro al que ya existía;
 *   2. da de alta las categorías y clasificaciones del COA (73 y 149), reusa
 *      las que ya existen con el mismo nombre (sin distinguir acentos ni
 *      mayúsculas) y les pone el orden y la ortografía del COA;
 *   3. lo del catálogo de ejemplo que no está en el COA: si no tiene líneas,
 *      se da de baja; Eventos › Equipo, Proveedores y Clientes pasan a
 *      Eventos › Eventos; lo demás con líneas se queda y se lista. Viajes ›
 *      Viajes se queda: es la de los viajes calculados;
 *   4. llena qué clasificaciones ve cada departamento (tabla de 0024).
 *
 * Al final comprueba que el total de cada versión no se movió (la B-26 de
 * prod: $6,426,591.28). Si se movió, con --commit no escribe nada.
 *
 * Idempotente: una segunda corrida no crea nada. Nunca borra (la app no tiene
 * DELETE): lo que sobra se da de baja.
 *
 * USO (por omisión, modo de prueba: corre todo en una transacción y la deshace):
 *   npm run fpa:catalogo
 *   npm run fpa:catalogo -- --commit
 *
 * Requiere la migración 0024. Se niega a correr con NODE_ENV=production: en
 * prod se corre desde un contenedor efímero, como fpa:arranque.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CatalogoCoa } from '../src/fpa/carga/coa';
import { clave } from '../src/fpa/carga/normalizar';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  COMMIT,
  compararTotales,
  enTransaccion,
  guardiaProduccion,
  log,
  totalesPorVersion,
  type Tx,
} from './fpa-comun';

const ARCHIVO = join(__dirname, 'data', 'fpa-coa.json');

/** Clasificaciones de la plataforma que no vienen en el COA y se quedan. */
const PLATAFORMA = new Set([`${clave('Viajes')}|${clave('Viajes')}`]);

/** Del catálogo de ejemplo al del COA, cuando la pareja es clara. */
const REMAPEO: Record<string, string> = {
  [`${clave('Eventos')}|${clave('Equipo')}`]: `${clave('Eventos')}|${clave('Eventos')}`,
  [`${clave('Eventos')}|${clave('Proveedores')}`]: `${clave('Eventos')}|${clave('Eventos')}`,
  [`${clave('Eventos')}|${clave('Clientes')}`]: `${clave('Eventos')}|${clave('Eventos')}`,
};

const parKey = (categoria: string, clasificacion: string) =>
  `${clave(categoria)}|${clave(clasificacion)}`;

/** De varias filas con la misma clave, la activa (y la más antigua). */
function elegir<T extends { is_active: boolean; created_at: Date }>(
  filas: T[],
): T | null {
  if (filas.length === 0) return null;
  return [...filas].sort(
    (a, b) =>
      Number(b.is_active) - Number(a.is_active) ||
      a.created_at.getTime() - b.created_at.getTime(),
  )[0];
}

interface Resultado {
  problemas: string[];
  avisos: string[];
  cuenta: Record<string, number>;
  categoriasCoa: number;
  categoriasGastosGenerales: number;
  totales: Array<[string, string]>;
}

export async function cargarCatalogo(
  tx: Tx,
  coa: CatalogoCoa,
): Promise<Resultado> {
  const problemas: string[] = [];
  const avisos: string[] = [];
  const cuenta: Record<string, number> = {};
  const sumar = (k: string, n = 1) => (cuenta[k] = (cuenta[k] ?? 0) + n);
  const antes = await totalesPorVersion(tx);

  // 1. Departamentos con su centro de costos
  const deptos = await tx.fpa_departments.findMany();
  const deptoId = new Map<string, string>();
  for (const d of coa.departamentos) {
    const iguales = deptos.filter((x) => clave(x.name) === clave(d.nombre));
    if (iguales.length > 1) {
      avisos.push(
        `Hay ${iguales.length} departamentos "${d.nombre}"; se usa el activo`,
      );
    }
    const ocupado = deptos.find(
      (x) =>
        x.is_active &&
        x.cost_center === d.centro_costos &&
        clave(x.name) !== clave(d.nombre),
    );
    const actual = elegir(iguales);
    if (ocupado) {
      avisos.push(
        `${d.centro_costos} ya es de ${ocupado.name}: ${d.nombre} se queda sin centro de costos`,
      );
    }
    if (actual) {
      const datos: { cost_center?: string; is_active?: boolean } = {};
      if (!actual.cost_center && !ocupado) {
        datos.cost_center = d.centro_costos;
        sumar('departamentos con su centro de costos');
      } else if (actual.cost_center && actual.cost_center !== d.centro_costos) {
        avisos.push(
          `${actual.name} tiene el centro ${actual.cost_center} y el COA dice ${d.centro_costos}: no se cambia`,
        );
      }
      if (!actual.is_active) {
        datos.is_active = true;
        sumar('departamentos reactivados');
      }
      if (Object.keys(datos).length > 0) {
        await tx.fpa_departments.update({
          where: { id: actual.id },
          data: datos,
        });
      }
      deptoId.set(d.nombre, actual.id);
    } else {
      const nuevo = await tx.fpa_departments.create({
        data: { name: d.nombre, cost_center: ocupado ? null : d.centro_costos },
      });
      sumar('departamentos');
      deptoId.set(d.nombre, nuevo.id);
    }
  }

  // 2. Categorías y clasificaciones del COA
  const cats = await tx.fpa_categories.findMany({
    include: { fpa_classifications: true },
  });
  const clsId = new Map<string, string>();
  for (const c of coa.categorias) {
    let cat = elegir(cats.filter((x) => clave(x.name) === clave(c.nombre)));
    if (cat) {
      const datos: { name?: string; sort_order?: number; is_active?: boolean } =
        {};
      if (cat.name !== c.nombre) {
        datos.name = c.nombre;
        sumar('categorías con la ortografía del COA');
        avisos.push(`Categoría "${cat.name}" › "${c.nombre}"`);
      }
      if (cat.sort_order !== c.orden) datos.sort_order = c.orden;
      if (!cat.is_active) {
        datos.is_active = true;
        sumar('categorías reactivadas');
      }
      if (Object.keys(datos).length > 0) {
        await tx.fpa_categories.update({ where: { id: cat.id }, data: datos });
      }
    } else {
      const creada = await tx.fpa_categories.create({
        data: { name: c.nombre, sort_order: c.orden },
      });
      cat = { ...creada, fpa_classifications: [] };
      sumar('categorías');
    }
    for (const [i, k] of c.clasificaciones.entries()) {
      const actual = elegir(
        cat.fpa_classifications.filter(
          (x) => clave(x.name) === clave(k.nombre),
        ),
      );
      if (actual) {
        const datos: {
          name?: string;
          sort_order?: number;
          is_active?: boolean;
          allows_negative?: boolean;
        } = {};
        if (actual.name !== k.nombre) {
          datos.name = k.nombre;
          sumar('clasificaciones con la ortografía del COA');
          avisos.push(`${c.nombre} › "${actual.name}" › "${k.nombre}"`);
        }
        if (actual.sort_order !== i + 1) datos.sort_order = i + 1;
        if (!actual.is_active) {
          datos.is_active = true;
          sumar('clasificaciones reactivadas');
        }
        // Solo se enciende: lo que ya aceptaba negativos se respeta
        if (k.acepta_negativos && !actual.allows_negative) {
          datos.allows_negative = true;
          sumar('clasificaciones que ahora aceptan negativos');
        }
        if (Object.keys(datos).length > 0) {
          await tx.fpa_classifications.update({
            where: { id: actual.id },
            data: datos,
          });
        }
        clsId.set(parKey(c.nombre, k.nombre), actual.id);
      } else {
        const nueva = await tx.fpa_classifications.create({
          data: {
            category_id: cat.id,
            name: k.nombre,
            allows_negative: k.acepta_negativos,
            sort_order: i + 1,
          },
        });
        sumar('clasificaciones');
        clsId.set(parKey(c.nombre, k.nombre), nueva.id);
      }
    }
  }

  // Viajes › Viajes (la de los viajes calculados) no viene en el COA: si no
  // existe (una base sin el catálogo de ejemplo), se crea, sin departamentos
  const viajes = await tx.fpa_categories.findFirst({
    where: { name: { equals: 'Viajes', mode: 'insensitive' }, is_active: true },
    include: { fpa_classifications: true },
  });
  if (
    viajes &&
    !viajes.fpa_classifications.some((k) => clave(k.name) === clave('Viajes'))
  ) {
    await tx.fpa_classifications.create({
      data: { category_id: viajes.id, name: 'Viajes', sort_order: 99 },
    });
    sumar('clasificación Viajes › Viajes (viajes calculados)');
  } else if (viajes) {
    const k = viajes.fpa_classifications.find(
      (x) => clave(x.name) === clave('Viajes'),
    );
    if (k && !k.is_active) {
      await tx.fpa_classifications.update({
        where: { id: k.id },
        data: { is_active: true },
      });
      sumar('clasificación Viajes › Viajes reactivada');
    }
  }

  // 3. Lo del catálogo de ejemplo que no está en el COA
  const vivas = await tx.fpa_classifications.findMany({
    where: { is_active: true },
    include: { fpa_categories: true },
  });
  for (const k of vivas) {
    const key = parKey(k.fpa_categories.name, k.name);
    if (clsId.has(key) || PLATAFORMA.has(key)) continue;
    const etiqueta = `${k.fpa_categories.name} › ${k.name}`;
    const usadas = await tx.fpa_budget_lines.count({
      where: { classification_id: k.id, is_active: true },
    });
    const destino = REMAPEO[key] ? clsId.get(REMAPEO[key]) : undefined;
    if (usadas > 0 && !destino) {
      avisos.push(
        `${etiqueta}: no está en el COA y tiene ${usadas} línea(s); se queda para decidirla con Laura`,
      );
      continue;
    }
    if (usadas > 0 && destino) {
      await tx.fpa_budget_lines.updateMany({
        where: { classification_id: k.id, is_active: true },
        data: { classification_id: destino },
      });
      sumar('líneas pasadas a su clasificación del COA', usadas);
      avisos.push(`${etiqueta}: ${usadas} línea(s) pasan a Eventos › Eventos`);
    }
    await tx.fpa_classifications.update({
      where: { id: k.id },
      data: { is_active: false },
    });
    sumar('clasificaciones de ejemplo dadas de baja');
  }
  // Una categoría de ejemplo que se quedó sin clasificaciones vivas, de baja
  const sinClasificaciones = await tx.fpa_categories.findMany({
    where: {
      is_active: true,
      fpa_classifications: { none: { is_active: true } },
    },
  });
  for (const c of sinClasificaciones) {
    await tx.fpa_categories.update({
      where: { id: c.id },
      data: { is_active: false },
    });
    sumar('categorías de ejemplo dadas de baja');
  }

  // 4. Qué clasificaciones ve cada departamento
  const parejas = await tx.fpa_department_classifications.findMany();
  for (const [depto, pares] of Object.entries(coa.pares)) {
    const departmentId = deptoId.get(depto);
    if (!departmentId) {
      problemas.push(`el departamento ${depto} del COA no quedó dado de alta`);
      continue;
    }
    const delCoa = new Set<string>();
    for (const [c, k] of pares) {
      const classificationId = clsId.get(parKey(c, k));
      if (!classificationId) {
        problemas.push(`${depto}: falta la clasificación ${c} › ${k}`);
        continue;
      }
      delCoa.add(classificationId);
      const actual = parejas.find(
        (p) =>
          p.department_id === departmentId &&
          p.classification_id === classificationId,
      );
      if (!actual) {
        await tx.fpa_department_classifications.create({
          data: {
            department_id: departmentId,
            classification_id: classificationId,
          },
        });
        sumar('clasificaciones por departamento');
      } else if (!actual.is_active) {
        await tx.fpa_department_classifications.update({
          where: { id: actual.id },
          data: { is_active: true },
        });
        sumar('clasificaciones por departamento reactivadas');
      }
    }
    for (const p of parejas) {
      if (
        p.department_id === departmentId &&
        p.is_active &&
        !delCoa.has(p.classification_id)
      ) {
        await tx.fpa_department_classifications.update({
          where: { id: p.id },
          data: { is_active: false },
        });
        sumar('clasificaciones por departamento dadas de baja');
      }
    }
  }

  // Verificación: sin duplicados y sin mover el total de ninguna versión
  const activas = await tx.fpa_categories.findMany({
    where: { is_active: true },
  });
  const vistas = new Map<string, string>();
  for (const c of activas) {
    const previa = vistas.get(clave(c.name));
    if (previa)
      problemas.push(`categorías duplicadas: "${previa}" y "${c.name}"`);
    vistas.set(clave(c.name), c.name);
  }
  const despues = await totalesPorVersion(tx);
  problemas.push(...compararTotales(antes, despues));
  const naesGe = new Set(
    [...(coa.pares.NAES ?? []), ...(coa.pares.GE ?? [])].map(([c]) => clave(c)),
  );
  return {
    problemas,
    avisos,
    cuenta,
    categoriasCoa: coa.categorias.length,
    categoriasGastosGenerales: coa.categorias.filter(
      (c) => !naesGe.has(clave(c.nombre)),
    ).length,
    totales: [...despues.entries()].map(([codigo, t]) => [
      codigo,
      `${t.total.toFixed(2)} (${t.lineas} líneas${t.noDisponibles ? `, ${t.noDisponibles} no disponibles` : ''})`,
    ]),
  };
}

async function main() {
  guardiaProduccion('fpa-catalogo');
  const coa = JSON.parse(readFileSync(ARCHIVO, 'utf8')) as CatalogoCoa & {
    fuente: { archivo: string; md5: string };
  };
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    log(
      COMMIT
        ? 'Modo COMMIT: se escribe el catálogo del COA.'
        : 'Modo de prueba: se corre todo y se deshace (agrega --commit para escribir).',
    );
    log(`Fuente: ${coa.fuente.archivo} (md5 ${coa.fuente.md5})`);
    const { resultado: r, escrito } = await enTransaccion(prisma, (tx) =>
      cargarCatalogo(tx, coa),
    );
    const entradas = Object.entries(r.cuenta);
    log(
      entradas.length
        ? `${escrito ? 'Hecho' : 'Se haría'}:`
        : 'Nada nuevo: el catálogo del COA ya estaba.',
    );
    for (const [k, n] of entradas) log(`  - ${k}: ${n}`);
    log(
      `Categorías del COA: ${r.categoriasCoa} (${r.categoriasGastosGenerales} de gastos generales; las demás, de NAES y GE).`,
    );
    if (r.avisos.length > 0) {
      log('Avisos:');
      for (const a of r.avisos) log(`  · ${a}`);
    }
    log('Total de cada versión (no debe moverse):');
    for (const [codigo, t] of r.totales) log(`  = ${codigo}: ${t}`);
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

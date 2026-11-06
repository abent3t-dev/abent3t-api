/**
 * FP&A (bloque C) — prueba en dev de las tres cargas juntas, SIEMPRE en una
 * transacción que se deshace (no tiene modo de escribir):
 *   fpa:catalogo › fpa:areas (con perfiles de prueba) › fpa:b27
 * y después una segunda corrida de cada una, que no debe crear nada.
 *
 *   --desde-cero  antes aparta (renombra, dentro de la transacción) las áreas,
 *                 departamentos, categorías y versiones B-27 que ya existan,
 *                 para que todo se cree como en una base vacía.
 *   --archivo     el JSON del B-27 (por omisión, scripts/data/fpa-b27.json).
 *
 * USO: npx ts-node -T scripts/fpa-bloque-c-prueba.ts [--desde-cero] [--archivo <ruta.json>]
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CatalogoCoa } from '../src/fpa/carga/coa';
import { PrismaService } from '../src/prisma/prisma.service';
import { cargarAreas } from './fpa-areas';
import { cargarB27, type DatosB27 } from './fpa-b27';
import { cargarCatalogo } from './fpa-catalogo';
import {
  guardiaProduccion,
  log,
  opcion,
  totalesPorVersion,
  type Tx,
} from './fpa-comun';

const DESDE_CERO = process.argv.includes('--desde-cero');

class Deshacer extends Error {}

async function apartar(tx: Tx) {
  const sufijo = ' (apartada en la prueba)';
  await tx.$executeRaw`UPDATE fpa_areas SET name = left(name, 90) || ${sufijo}`;
  await tx.$executeRaw`UPDATE fpa_departments SET name = left(name, 90) || ${sufijo}, cost_center = NULL`;
  await tx.$executeRaw`UPDATE fpa_categories SET name = left(name, 90) || ${sufijo}`;
  await tx.$executeRaw`UPDATE fpa_versions SET code = left(code, 10) || '-x' WHERE code ILIKE 'B-27%'`;
}

const resumen = (cuenta: Record<string, number>) =>
  Object.entries(cuenta)
    .map(([k, n]) => `${k}: ${n}`)
    .join(' · ') || 'nada';

async function main() {
  guardiaProduccion('fpa-bloque-c-prueba');
  if (process.argv.includes('--commit')) {
    throw new Error(
      'Esta prueba nunca escribe: corre cada script por separado con --commit',
    );
  }
  const coa = JSON.parse(
    readFileSync(join(__dirname, 'data', 'fpa-coa.json'), 'utf8'),
  ) as CatalogoCoa;
  const archivo =
    opcion('--archivo') ?? join(__dirname, 'data', 'fpa-b27.json');
  const datos = JSON.parse(readFileSync(archivo, 'utf8')) as DatosB27;
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    await prisma.$transaction(
      async (tx) => {
        const antes = await totalesPorVersion(tx);
        log(
          `Antes: ${[...antes].map(([c, t]) => `${c} ${t.total.toFixed(2)} (${t.lineas} líneas)`).join('; ')}`,
        );
        if (DESDE_CERO) {
          await apartar(tx);
          log('Desde cero: áreas, departamentos, categorías y B-27 apartados.');
        }
        for (const vuelta of [1, 2]) {
          log(`\n— Vuelta ${vuelta}`);
          const c = await cargarCatalogo(tx, coa);
          log(
            `  catálogo: ${resumen(c.cuenta)}${c.problemas.length ? ` · ✗ ${c.problemas.join(' | ')}` : ''}`,
          );
          const a = await cargarAreas(tx, true);
          log(
            `  áreas: ${resumen(a.cuenta)}${a.problemas.length ? ` · ✗ ${a.problemas.join(' | ')}` : ''}`,
          );
          if (vuelta === 1) {
            for (const linea of a.porArea) log(`    · ${linea}`);
            for (const x of a.avisos) log(`    aviso: ${x}`);
          }
          const b = await cargarB27(tx, datos);
          log(
            `  B-27: ${resumen(b.cuenta)}${b.problemas.length ? ` · ✗ ${b.problemas.join(' | ')}` : ''}`,
          );
          if (vuelta === 1) {
            for (const x of b.porArea)
              log(
                `    = ${x.area}: archivo ${x.archivo} · lector ${x.lineas} · base ${x.base}`,
              );
            log(
              `    proveedores ligados: ${b.proveedores.length}; por clasificar: ${b.porClasificar.length}`,
            );
          }
        }
        const despues = await totalesPorVersion(tx);
        log(
          `\nDespués: ${[...despues].map(([c, t]) => `${c} ${t.total.toFixed(2)} (${t.lineas} líneas)`).join('; ')}`,
        );
        throw new Deshacer();
      },
      { timeout: 600_000, maxWait: 20_000 },
    );
  } catch (e) {
    if (!(e instanceof Deshacer)) throw e;
    log('Todo se deshizo: dev quedó como estaba.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
});

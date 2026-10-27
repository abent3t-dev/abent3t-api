/**
 * FP&A (B0, 26-oct) — arranque del módulo en prod para el primer acceso de
 * planeación (Laura y Liliana), en modo de pruebas.
 *
 * Carga lo mismo que se enseñó en la reunión del 26-oct, sin usuarios de
 * prueba (los datos viven en fpa-datos-base.ts, que comparte con fpa-seed-dev):
 *   - catálogo base de categorías y clasificaciones;
 *   - la versión B-26 en captura, con inflación 4%, USD 20 / EUR 22 y las
 *     tarifas de viaje de la hoja '2' de los B-26;
 *   - áreas Compras, Planta y Recursos Humanos con su departamento propio, y
 *     los departamentos SSGG e IT que captura RH; cada área activa (también
 *     una dada de alta antes en pantalla) con su presupuesto B-26 en borrador;
 *   - el B-26 completo de Compras (8 líneas = $2,659,000) y líneas de ejemplo
 *     de Planta y RH (PI System, INTER LAB, Gympass y una capacitación).
 *     Con --sin-lineas, solo lo de arriba.
 *
 * No crea usuarios ni asigna roles: el rol fpa_planeacion de cada persona se
 * da en Administración › Usuarios (o con POST /auth/users). Conviene correr
 * el arranque ANTES de dar los roles. created_by queda vacío (carga inicial).
 *
 * Idempotente: lo que ya existe se reutiliza y nada se borra; los nombres se
 * buscan sin distinguir mayúsculas. Las líneas se reconocen por su source_ref
 * (el mismo que usará el importador del bloque B, así que no se duplican al
 * cargar los Excel completos), y una línea que alguien dio de baja en la
 * plataforma NO se vuelve a crear.
 *
 * Proveedores: se ligan al catálogo de SAP solo si el nombre coincide con uno
 * (igual o, si no, uno solo que lo contiene). La salida lista cada decisión:
 * revisarla en el dry-run de prod, donde puede haber homónimos.
 *
 * USO (por omisión DRY-RUN: corre todo en una transacción y la deshace):
 *   npm run fpa:arranque
 *   npm run fpa:arranque -- --commit
 *   npm run fpa:arranque -- --sin-lineas --commit
 *
 * Al final comprueba con fpa-calc que cada línea dé la cifra de Laura. Si no
 * cuadra, con --commit no se escribe nada (y sale con código 1).
 *
 * Nota: el folio de las líneas (L-000001…) lo genera la base con una
 * secuencia que no regresa en un rollback: cada dry-run gasta 12 folios, así
 * que tras un dry-run la carga real empieza en L-000013. Es cosmético.
 *
 * GUARDA: se niega a correr con NODE_ENV=production (regla 7). La carga a la
 * BD de prod se hace desde un contenedor efímero apuntando DATABASE_URL a prod
 * (mecánica del 2026-09-22, como contracts:import-excel).
 */
import 'dotenv/config';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  cargarBase,
  EXPECTED_BY_AREA,
  verificarBase,
  type CargarBaseResult,
} from './fpa-datos-base';

const COMMIT = process.argv.includes('--commit');
const WITH_LINES = !process.argv.includes('--sin-lineas');

class DryRunRollback extends Error {}
class VerificationFailed extends Error {}

const log = (msg: string) => console.log(msg);

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Guardia: fpa-arranque no corre con NODE_ENV=production (regla 7). Córrelo desde un contenedor efímero con DATABASE_URL de prod.',
    );
  }
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    log(
      COMMIT
        ? 'Modo COMMIT: se escribe el arranque de FP&A.'
        : 'Modo DRY-RUN: se corre todo y se deshace (agrega --commit para escribir).',
    );
    log(
      WITH_LINES
        ? 'Con líneas: el B-26 de Compras y las de ejemplo de Planta y RH.'
        : 'Sin líneas (--sin-lineas): catálogo, versión, áreas y presupuestos.',
    );
    let result: CargarBaseResult | null = null;
    let problems: string[] = [];
    let skipped: string[] = [];
    let rolledBack = false;
    try {
      await prisma.$transaction(
        async (tx) => {
          const loaded = await cargarBase(tx, {
            createdBy: null,
            versionNotes:
              'Primer acceso en pruebas (oct-2026): parámetros del B-26 de los Excel de Laura; el B-26 completo de Compras y líneas de ejemplo de Planta y RH.',
            withLines: WITH_LINES,
            restoreInactiveLines: false,
          });
          result = loaded;
          if (WITH_LINES) {
            const check = await verificarBase(
              tx,
              loaded.versionId,
              loaded.budgetIds,
            );
            problems = check.problems;
            skipped = check.skipped;
            for (const [area, total] of check.byArea) {
              log(`  = ${area}: ${total.toFixed(2)}`);
            }
          }
          // Si no cuadra, no se escribe nada aunque venga --commit
          if (problems.length > 0) throw new VerificationFailed();
          if (!COMMIT) throw new DryRunRollback();
        },
        { timeout: 120_000, maxWait: 20_000 },
      );
    } catch (e) {
      if (e instanceof VerificationFailed) rolledBack = true;
      else if (!(e instanceof DryRunRollback)) throw e;
    }
    const r = result as CargarBaseResult | null;
    if (!r) throw new Error('No se generó el plan');
    const entries = Object.entries(r.counts);
    const wrote = COMMIT && !rolledBack;
    log(
      entries.length
        ? `${wrote ? 'Creado' : 'Se crearía'}:`
        : 'Nada nuevo: el arranque ya estaba.',
    );
    for (const [k, n] of entries) log(`  - ${k}: ${n}`);
    if (r.notes.length > 0) {
      log('Notas:');
      for (const n of r.notes) log(`  · ${n}`);
    }
    if (skipped.length > 0) {
      log(
        `Líneas de ejemplo dadas de baja en la plataforma (no cuentan): ${skipped.join('; ')}`,
      );
    }
    if (problems.length > 0) {
      log(
        `Las cifras NO cuadran con Laura${COMMIT ? ': no se escribió nada' : ''}.`,
      );
      for (const p of problems) log(`  ✗ ${p}`);
      log(
        '  (Si alguien ya editó las líneas de ejemplo en la plataforma, es esperable.)',
      );
      process.exitCode = 1;
    } else if (WITH_LINES) {
      log(
        skipped.length > 0
          ? 'Las líneas vivas cuadran con Laura (fpa-calc); las dadas de baja no se comparan.'
          : `Cifras de Laura comprobadas con fpa-calc: ${EXPECTED_BY_AREA}.`,
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

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
 * Todo menos los usuarios de prueba vive en fpa-datos-base.ts, que comparte
 * con fpa-arranque (el primer acceso en prod): dev y prod cargan lo mismo.
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
import { PrismaService } from '../src/prisma/prisma.service';
import {
  cargarBase,
  EXPECTED_BY_AREA,
  verificarBase,
  type Tx,
} from './fpa-datos-base';

const COMMIT = process.argv.includes('--commit');
const RESET_PASSWORDS = process.argv.includes('--reset-passwords');

/** departments 'Compras' del seed de dev (0003_seed_data.sql:26); prod no la tiene. */
const DEV_MARKER_DEPARTMENT = '0ef8feda-5f93-40d2-9c9a-91203cb5316f';

class DryRunRollback extends Error {}

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

const log = (msg: string) => console.log(msg);

async function seed(tx: Tx, password: string) {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  // Usuarios de prueba (login local de dev) con su rol fpa
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
  }

  // Catálogo, versión, áreas, presupuestos y líneas: lo mismo que en prod
  const base = await cargarBase(tx, {
    createdBy: people.planeacion,
    versionNotes:
      'Datos de ejemplo de dev (fpa-seed-dev): cifras de los Excel de Laura.',
    withLines: true,
    // Dev: una línea de Laura dada de baja se vuelve a crear (restaura la demo)
    restoreInactiveLines: true,
  });
  for (const [k, n] of Object.entries(base.counts)) {
    counts[k] = (counts[k] ?? 0) + n;
  }

  // Responsabilidades de los usuarios de prueba en Compras
  for (const u of TEST_USERS) {
    if (!u.duty || !u.area) continue;
    const areaId = base.areaIds.get(u.area) as string;
    const exists = await tx.fpa_assignments.findFirst({
      where: {
        area_id: areaId,
        duty: u.duty,
        profile_id: people[u.key],
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
        data: { area_id: areaId, duty: u.duty, profile_id: people[u.key] },
      });
    } else if (!exists && titular) {
      log(`  (el área ${u.area} ya tiene titular de ${u.duty}: no se toca)`);
    }
  }
  return {
    counts,
    versionId: base.versionId,
    budgetIds: base.budgetIds,
    notes: base.notes,
  };
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
          const check = await verificarBase(
            tx,
            seeded.versionId,
            seeded.budgetIds,
          );
          problems = check.problems;
          for (const [area, total] of check.byArea) {
            log(`  = ${area}: ${total.toFixed(2)}`);
          }
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
    for (const n of r.notes) log(`  · ${n}`);
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
      log(`Cifras de Laura comprobadas con fpa-calc: ${EXPECTED_BY_AREA}.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
});

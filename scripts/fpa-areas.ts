/**
 * FP&A (bloque C, C2) — da de alta las 13 áreas reales con su gente
 * (documentation/TAREAS_FPA_2026-11-04.md, C2). Los datos y las reglas viven
 * en src/fpa/carga/areas-reales.ts, con pruebas.
 *
 * Qué hace:
 *   1. cada área con su departamento propio, el del COA (lo crea fpa:catalogo,
 *      que va antes): Compras, Planta y Recursos Humanos se reusan; Servicios
 *      Generales e IT dejan de ser de RH y pasan a sus áreas;
 *   2. como el alta de la pantalla, cada área nueva recibe su presupuesto en
 *      borrador en las versiones en captura (en prod, la B-26);
 *   3. quién captura y quién aprueba, con los perfiles que ya existen:
 *      - a quien no tenga perfil lo lista, sin crearlo (se da de alta con
 *        POST /api/auth/users cuando Alex lo diga);
 *      - no da roles: el rol fpa_area se da cuando César les dé acceso;
 *      - si el área ya tiene otro titular, lo respeta y registra al de la
 *        relación como "también captura" (o suplente);
 *   4. lista lo que falta de Laura: Seguros, quién captura NAES y Uriel.
 *
 * Idempotente: lo que ya existe se reusa y nada se borra. Al final comprueba
 * que el total de cada versión no se movió.
 *
 * USO (por omisión, modo de prueba: corre todo en una transacción y la deshace):
 *   npm run fpa:areas
 *   npm run fpa:areas -- --commit
 *   npm run fpa:areas -- --perfiles-de-prueba   (solo dev y sin --commit: crea
 *     perfiles temporales para los correos que falten, para probar las altas
 *     completas; se deshacen con todo lo demás)
 *
 * Se niega a correr con NODE_ENV=production: en prod se corre desde un
 * contenedor efímero, como fpa:arranque.
 */
import 'dotenv/config';
import { clave } from '../src/fpa/carga/normalizar';
import {
  AREAS_PENDIENTES,
  AREAS_REALES,
  responsablesDe,
} from '../src/fpa/carga/areas-reales';
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

const PERFILES_DE_PRUEBA = process.argv.includes('--perfiles-de-prueba');
const NOTA = 'Relación de capturistas (27-oct) y reunión del 4-nov';

interface Resultado {
  problemas: string[];
  avisos: string[];
  cuenta: Record<string, number>;
  faltan: string[];
  sinRol: string[];
  porArea: string[];
}

export async function cargarAreas(
  tx: Tx,
  perfilesDePrueba = PERFILES_DE_PRUEBA,
): Promise<Resultado> {
  const problemas: string[] = [];
  const avisos: string[] = [];
  const cuenta: Record<string, number> = {};
  const sumar = (k: string, n = 1) => (cuenta[k] = (cuenta[k] ?? 0) + n);
  const antes = await totalesPorVersion(tx);

  const deptos = await tx.fpa_departments.findMany();
  const areas = await tx.fpa_areas.findMany();
  const abiertas = await tx.fpa_versions.findMany({
    where: {
      is_active: true,
      kind: { in: ['presupuesto', 'forecast'] },
      status: 'captura',
    },
    select: { id: true, code: true },
  });

  // 1 y 2. Áreas, su departamento y su presupuesto en las versiones abiertas
  const areaId = new Map<string, string>();
  for (const [i, a] of AREAS_REALES.entries()) {
    const depto = deptos.find(
      (d) => d.is_active && clave(d.name) === clave(a.departamento),
    );
    if (!depto) {
      problemas.push(
        `falta el departamento ${a.departamento}: corre antes fpa:catalogo`,
      );
      continue;
    }
    let area = areas.find((x) => clave(x.name) === clave(a.area));
    if (!area) {
      area = await tx.fpa_areas.create({
        data: { name: a.area, sort_order: i + 1, department_id: depto.id },
      });
      sumar('áreas');
    } else {
      const datos: {
        sort_order?: number;
        department_id?: string;
        is_active?: boolean;
      } = {};
      if (area.sort_order !== i + 1) datos.sort_order = i + 1;
      if (area.department_id !== depto.id) {
        if (area.department_id) {
          avisos.push(
            `${area.name}: su departamento propio pasa a ser ${depto.name}`,
          );
        }
        datos.department_id = depto.id;
        sumar('áreas ligadas a su departamento');
      }
      if (!area.is_active) {
        datos.is_active = true;
        sumar('áreas reactivadas');
      }
      if (Object.keys(datos).length > 0) {
        area = await tx.fpa_areas.update({
          where: { id: area.id },
          data: datos,
        });
      }
    }
    if (depto.area_id !== area.id) {
      if (depto.area_id) {
        const antes = areas.find((x) => x.id === depto.area_id)?.name ?? '¿?';
        avisos.push(
          `El departamento ${depto.name} pasa de ${antes} a ${area.name}`,
        );
      }
      await tx.fpa_departments.update({
        where: { id: depto.id },
        data: { area_id: area.id },
      });
      sumar('departamentos que pasan a su área');
    }
    for (const v of abiertas) {
      const tiene = await tx.fpa_budgets.findFirst({
        where: { version_id: v.id, area_id: area.id, is_active: true },
        select: { id: true },
      });
      if (!tiene) {
        await tx.fpa_budgets.create({
          data: { version_id: v.id, area_id: area.id },
        });
        sumar(`presupuestos ${v.code} en borrador`);
      }
    }
    areaId.set(a.area, area.id);
  }

  // 3. Quién captura y quién aprueba
  const correos = [
    ...new Set(
      AREAS_REALES.flatMap((a) => responsablesDe(a).map((r) => r.email)),
    ),
  ];
  const perfiles = await tx.profiles.findMany({
    where: {
      OR: correos.map((email) => ({
        email: { equals: email, mode: 'insensitive' as const },
      })),
    },
    select: { id: true, email: true, full_name: true, is_active: true },
  });
  if (perfilesDePrueba) {
    for (const email of correos) {
      if (perfiles.some((p) => p.email.toLowerCase() === email)) continue;
      perfiles.push(
        await tx.profiles.create({
          data: { email, full_name: `Prueba ${email.split('@')[0]}` },
          select: { id: true, email: true, full_name: true, is_active: true },
        }),
      );
    }
  }
  const perfilDe = (email: string) =>
    perfiles.find((p) => p.email.toLowerCase() === email && p.is_active);

  const faltanPorCorreo = new Map<string, string[]>();
  const porArea: string[] = [];
  for (const a of AREAS_REALES) {
    const id = areaId.get(a.area);
    if (!id) continue;
    const vigentes = await tx.fpa_assignments.findMany({
      where: { area_id: id, is_active: true },
      include: {
        profiles_fpa_assignments_profile_idToprofiles: {
          select: { email: true },
        },
      },
    });
    const quedan: string[] = [];
    for (const r of responsablesDe(a)) {
      const papel =
        r.duty === 'captura'
          ? r.is_alternate
            ? 'también captura'
            : 'captura'
          : r.is_alternate
            ? 'suplente de aprobación'
            : 'aprueba';
      const perfil = perfilDe(r.email);
      if (!perfil) {
        const lista = faltanPorCorreo.get(r.email) ?? [];
        lista.push(`${papel} en ${a.area}`);
        faltanPorCorreo.set(r.email, lista);
        continue;
      }
      const suya = vigentes.find((v) => v.profile_id === perfil.id);
      if (suya) {
        if (suya.duty !== r.duty) {
          avisos.push(
            `${a.area}: ${r.email} ya tiene la función ${suya.duty}; no se le agrega ${r.duty}`,
          );
        } else if (suya.is_alternate !== r.is_alternate) {
          avisos.push(
            `${a.area}: ${r.email} ya está en ${r.duty} como ${suya.is_alternate ? 'suplente' : 'titular'}; se deja así`,
          );
        }
        quedan.push(`${papel}: ${r.email}`);
        continue;
      }
      let alterna = r.is_alternate;
      if (!alterna) {
        const otro = vigentes.find(
          (v) =>
            v.duty === r.duty && !v.is_alternate && v.profile_id !== perfil.id,
        );
        if (otro) {
          alterna = true;
          avisos.push(
            `${a.area}: ya hay titular de ${r.duty} (${otro.profiles_fpa_assignments_profile_idToprofiles.email}); ${r.email} entra como ${r.duty === 'captura' ? 'también captura' : 'suplente'}`,
          );
        }
      }
      const creada = await tx.fpa_assignments.create({
        data: {
          area_id: id,
          duty: r.duty,
          profile_id: perfil.id,
          is_alternate: alterna,
          notes: NOTA,
        },
      });
      vigentes.push({
        ...creada,
        profiles_fpa_assignments_profile_idToprofiles: { email: perfil.email },
      });
      sumar(
        r.duty === 'captura'
          ? 'responsables de captura'
          : 'responsables de aprobación',
      );
      quedan.push(`${papel}: ${r.email}`);
    }
    porArea.push(
      `${a.area}: ${quedan.length ? quedan.join('; ') : 'nadie registrado'}${a.pendiente ? ` · pendiente: ${a.pendiente}` : ''}`,
    );
  }

  // Quién no tiene rol de FP&A (se da cuando César les dé acceso)
  const conPerfil = perfiles.filter((p) =>
    correos.includes(p.email.toLowerCase()),
  );
  const roles = await tx.user_roles.findMany({
    where: {
      profile_id: { in: conPerfil.map((p) => p.id) },
      module: 'fpa',
      is_active: true,
    },
    select: { profile_id: true },
  });
  const sinRol = conPerfil
    .filter((p) => !roles.some((r) => r.profile_id === p.id))
    .map((p) => p.email.toLowerCase())
    .sort();

  const despues = await totalesPorVersion(tx);
  problemas.push(...compararTotales(antes, despues));
  const faltan = [...faltanPorCorreo.entries()].map(
    ([email, papeles]) => `${email}: ${papeles.join('; ')}`,
  );
  return { problemas, avisos, cuenta, faltan, sinRol, porArea };
}

async function main() {
  guardiaProduccion('fpa-areas');
  if (PERFILES_DE_PRUEBA && COMMIT) {
    throw new Error(
      '--perfiles-de-prueba es solo para el modo de prueba (sin --commit)',
    );
  }
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    log(
      COMMIT
        ? 'Modo COMMIT: se escriben las áreas reales y su gente.'
        : 'Modo de prueba: se corre todo y se deshace (agrega --commit para escribir).',
    );
    if (PERFILES_DE_PRUEBA) {
      log('Con perfiles de prueba para los correos que falten (se deshacen).');
    }
    const { resultado: r, escrito } = await enTransaccion(prisma, (tx) =>
      cargarAreas(tx),
    );
    const entradas = Object.entries(r.cuenta);
    log(
      entradas.length
        ? `${escrito ? 'Hecho' : 'Se haría'}:`
        : 'Nada nuevo: las áreas y su gente ya estaban.',
    );
    for (const [k, n] of entradas) log(`  - ${k}: ${n}`);
    log('Cómo quedan:');
    for (const linea of r.porArea) log(`  · ${linea}`);
    if (r.avisos.length > 0) {
      log('Avisos:');
      for (const a of r.avisos) log(`  · ${a}`);
    }
    log(
      r.faltan.length
        ? `Sin perfil en la plataforma (${r.faltan.length}; no se crean, se dan de alta cuando Alex diga):`
        : 'Todos tienen perfil.',
    );
    for (const f of r.faltan) log(`  · ${f}`);
    if (r.sinRol.length > 0) {
      log(
        `Sin rol de FP&A (${r.sinRol.length}; se da cuando César les dé acceso): ${r.sinRol.join(', ')}`,
      );
    }
    log('Lo que falta de Laura:');
    for (const p of AREAS_PENDIENTES) log(`  · ${p}`);
    for (const a of AREAS_REALES.filter((x) => x.pendiente)) {
      log(`  · ${a.area}: ${a.pendiente}`);
    }
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

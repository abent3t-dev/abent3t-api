/**
 * Importación histórica del módulo de Capacitación 2026 — Abent 3T
 *
 * Fuente: documentation/Importacion_capacitacion_Abent3T_2026.xlsx
 * Guía:   documentation/CLAUDE.md § "IMPORTACIÓN DE DATOS HISTÓRICOS DE CAPACITACIÓN"
 *
 * Uso (dentro del contenedor abent3t-api):
 *   node scripts/import-capacitacion-2026.js <ruta.xlsx> [--parse-only | --dry-run | --commit]
 *
 *   --parse-only  Solo parsea y valida el workbook. No conecta a la BD.
 *   --dry-run     (default) Parsea, resuelve contra la BD y reporta qué haría. No escribe.
 *   --commit      Ejecuta la importación en una sola transacción y verifica conteos.
 *
 * Idempotente: re-correr con --commit no duplica (llaves naturales: name/email/
 * (year,semester)/(edition,profile); ediciones por (course_id,start_date,end_date)).
 * Nota: course_editions NO tiene columna notes — las notas de edición del workbook
 * son informativas y ya están capturadas en payment_reference/prorate_cost.
 *
 * Ajustes acordados (chat 2026-09-10):
 *   - E041 "Mantenimiento" sin fechas → se omite edición + su inscripción (warning).
 *   - Correos @bent3t.com → se corrigen a @abent3t.com.
 *   - total_hours decimales → Math.round.
 *   - Correos personales (hotmail/gmail) se importan; no podrán entrar por SSO.
 */

'use strict';

const ExcelJS = require('exceljs');

const ARGS = process.argv.slice(2);
const FILE = ARGS.find((a) => !a.startsWith('--'));
const MODE = ARGS.includes('--commit') ? 'commit' : ARGS.includes('--parse-only') ? 'parse-only' : 'dry-run';

if (!FILE) {
  console.error('Uso: node scripts/import-capacitacion-2026.js <ruta.xlsx> [--parse-only|--dry-run|--commit]');
  process.exit(1);
}

const EMAIL_TYPO_FIX = { '@bent3t.com': '@abent3t.com' };
const SKIP_EDITIONS = new Set(['E041']); // sin start_date (NOT NULL en BD)
const TZ_OFFSET = '-06:00'; // CDMX para timestamptz

const warnings = [];
const warn = (msg) => warnings.push(msg);

// ---------- helpers de celdas ----------

function cellVal(cell) {
  let v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v.formula !== undefined) {
      if (v.result !== undefined && v.result !== null) v = v.result;
      else if (v.formula === 'FALSE()') return false;
      else if (v.formula === 'TRUE()') return true;
      else return null; // fórmulas de auditoría (sumas/diferencias), no se importan
    } else if (v.richText) {
      v = v.richText.map((t) => t.text).join('');
    } else if (v.text !== undefined) {
      v = v.text;
    }
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10); // fechas como 'YYYY-MM-DD'
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  return v;
}

function sheetRows(ws) {
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    const vals = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      vals[col - 1] = cellVal(cell);
    });
    rows.push({ n, v: vals });
  });
  return rows.slice(1); // sin encabezado
}

function fixEmail(email) {
  if (!email) return null;
  let e = String(email).toLowerCase().trim();
  for (const [bad, good] of Object.entries(EMAIL_TYPO_FIX)) {
    if (e.endsWith(bad)) {
      const fixed = e.slice(0, -bad.length) + good;
      warn(`Correo corregido: ${e} → ${fixed}`);
      e = fixed;
    }
  }
  return e;
}

const normName = (s) => String(s).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const asDate = (ymd) => (ymd ? new Date(`${ymd}T00:00:00.000Z`) : null); // columnas @db.Date
const asTs = (ymd) => (ymd ? new Date(`${ymd}T00:00:00${TZ_OFFSET}`) : null); // timestamptz

// ---------- parseo del workbook ----------

async function parseWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const S = (name) => {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`Falta la hoja "${name}" en el workbook`);
    return sheetRows(ws);
  };

  const data = {
    departments: S('departments').map((r) => ({ name: r.v[0], is_active: r.v[1] !== false })),
    institutions: S('institutions').map((r) => ({
      name: r.v[0],
      type: r.v[1] || 'external',
      is_platform: r.v[2] === true,
      is_active: r.v[3] !== false,
    })),
    profiles: [],
    courses: S('courses').map((r) => {
      const hours = Number(r.v[2] || 0);
      if (!Number.isInteger(hours)) warn(`Curso "${r.v[0]}": ${hours} hrs → redondeado a ${Math.round(hours)} (total_hours es entero)`);
      if (hours === 0) warn(`Curso "${r.v[0]}": sin horas (total_hours=0)`);
      if (!r.v[1]) warn(`Curso "${r.v[0]}": sin institución (institution_id=NULL)`);
      return {
        name: r.v[0],
        institution: r.v[1] || null,
        total_hours: Math.round(hours),
        cost: Number(r.v[3] || 0),
        description: r.v[6] || null,
      };
    }),
    editions: [],
    enrollments: [],
    budgets: [],
  };

  for (const r of S('profiles')) {
    const email = fixEmail(r.v[1]);
    const p = {
      full_name: r.v[0],
      email,
      position: r.v[2] || null,
      department: r.v[3] || null,
      is_active: r.v[6] !== false,
    };
    if (!email) {
      warn(`Perfil OMITIDO (sin correo): ${p.full_name} — no puede crearse hasta tener email`);
      continue;
    }
    if (!/@abent3t\.com$/.test(email)) warn(`Correo no corporativo: ${p.full_name} <${email}> — se importa, pero NO podrá iniciar sesión por SSO (dominio no permitido)`);
    if (!p.is_active) warn(`Baja: ${p.full_name} — se importa con is_active=false y sin rol en user_roles`);
    data.profiles.push(p);
  }

  for (const r of S('course_editions')) {
    const e = {
      edition_key: r.v[0],
      course: r.v[1],
      start_date: r.v[2],
      end_date: r.v[3],
      cost_override: r.v[4] !== null && r.v[4] !== undefined ? Number(r.v[4]) : null,
      prorate_cost: r.v[5] === true,
      payment_status: r.v[6] || 'pending',
      payment_reference: r.v[7] || null,
      payment_date: r.v[8] || null,
      require_evidence_for_completion: r.v[9] === true,
      notes: r.v[10] || null,
    };
    if (SKIP_EDITIONS.has(e.edition_key) || !e.start_date) {
      warn(`Edición OMITIDA: ${e.edition_key} "${e.course}" sin start_date (NOT NULL en BD) — completar con Denisse e importar después`);
      continue;
    }
    data.editions.push(e);
  }
  const validEditionKeys = new Set(data.editions.map((e) => e.edition_key));

  for (const r of S('enrollments')) {
    const en = {
      fila_excel: r.v[0],
      email: fixEmail(r.v[1]),
      full_name: r.v[2],
      edition_key: r.v[5],
      status: r.v[8] || null,
      enrolled_at: r.v[9],
      completed_at: r.v[10],
      presupuesto_2025: r.v[12] === true,
      notes: r.v[15] || null,
    };
    if (!validEditionKeys.has(en.edition_key)) {
      warn(`Inscripción OMITIDA (fila Excel ${en.fila_excel}): ${en.full_name} → edición ${en.edition_key} omitida/inexistente`);
      continue;
    }
    if (!en.email) {
      warn(`Inscripción OMITIDA (fila Excel ${en.fila_excel}): ${en.full_name} sin correo`);
      continue;
    }
    if (!en.status) {
      warn(`Inscripción fila Excel ${en.fila_excel} (${en.full_name}): sin estatus — se usa 'inscrito'`);
      en.status = 'inscrito';
    }
    if (en.presupuesto_2025) {
      en.notes = [en.notes, 'Pagado con presupuesto 2025; no suma al presupuesto 2026.'].filter(Boolean).join(' · ');
    }
    data.enrollments.push(en);
  }

  for (const r of S('budgets')) {
    if (typeof r.v[1] !== 'number') continue; // filas Total / notas
    const b = {
      department: r.v[0],
      year: r.v[1],
      label: String(r.v[2]),
      assigned_amount: Number(r.v[3] || 0),
      consumed_amount: Number(r.v[4] || 0),
    };
    if (b.consumed_amount > b.assigned_amount) {
      warn(`Presupuesto sobre-ejercido: ${b.department} asignado $${b.assigned_amount} < usado $${b.consumed_amount} (dato real del Excel, se importa tal cual)`);
    }
    data.budgets.push(b);
  }

  // Período 2026 anual (el workbook no trae hoja periods)
  const years = [...new Set(data.budgets.map((b) => b.year))];
  data.periods = years.map((y) => ({
    year: y,
    semester: null,
    label: String(y),
    start_date: `${y}-01-01`,
    end_date: `${y}-12-31`,
  }));

  // Validaciones cruzadas fatales
  const deptSet = new Set(data.departments.map((d) => d.name));
  const instSet = new Set(data.institutions.map((i) => i.name));
  const courseSet = new Set(data.courses.map((c) => normName(c.name)));
  const emailSet = new Set(data.profiles.map((p) => p.email));
  const fatal = [];
  for (const p of data.profiles) if (p.department && !deptSet.has(p.department)) fatal.push(`Perfil ${p.email}: departamento "${p.department}" no está en la hoja departments`);
  for (const c of data.courses) if (c.institution && !instSet.has(c.institution)) fatal.push(`Curso "${c.name}": institución "${c.institution}" no está en la hoja institutions`);
  for (const e of data.editions) if (!courseSet.has(normName(e.course))) fatal.push(`Edición ${e.edition_key}: curso "${e.course}" no está en la hoja courses`);
  for (const en of data.enrollments) if (!emailSet.has(en.email)) fatal.push(`Inscripción fila ${en.fila_excel}: correo ${en.email} no está en la hoja profiles`);
  for (const b of data.budgets) if (!deptSet.has(b.department)) fatal.push(`Budget: departamento "${b.department}" no está en la hoja departments`);
  const dupCheck = new Set();
  for (const en of data.enrollments) {
    const k = `${en.edition_key}|${en.email}`;
    if (dupCheck.has(k)) fatal.push(`Inscripción duplicada en el workbook: ${k}`);
    dupCheck.add(k);
  }
  // La llave natural de edición (curso, start, end) debe ser única (es la llave de idempotencia en BD)
  const edNatKeys = new Set();
  for (const e of data.editions) {
    const k = `${normName(e.course)}|${e.start_date}|${e.end_date ?? ''}`;
    if (edNatKeys.has(k)) fatal.push(`Ediciones con misma llave natural (curso+fechas): ${e.edition_key} duplica a otra — no se pueden distinguir en BD`);
    edNatKeys.add(k);
  }
  if (fatal.length) {
    console.error('ERRORES FATALES en el workbook:');
    for (const f of fatal) console.error('  ✗ ' + f);
    process.exit(1);
  }
  return data;
}

// ---------- resolución contra BD e importación ----------

async function run() {
  const data = await parseWorkbook(FILE);

  console.log(`\n=== Importación capacitación 2026 — modo: ${MODE} ===`);
  console.log(`Workbook: ${FILE}`);
  console.log(`\nParseado: ${data.departments.length} departments, ${data.institutions.length} institutions, ` +
    `${data.periods.length} periods, ${data.profiles.length} profiles, ${data.courses.length} courses, ` +
    `${data.editions.length} editions, ${data.enrollments.length} enrollments, ${data.budgets.length} budgets`);

  if (MODE === 'parse-only') {
    printWarnings();
    console.log('\n(parse-only: no se consultó la BD)');
    return;
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    // Estado actual de la BD (para el plan create/reuse)
    const [dbDepts, dbInsts, dbPeriods, dbProfiles, dbCourses, dbEditions, dbBudgets] = await Promise.all([
      prisma.departments.findMany(),
      prisma.institutions.findMany(),
      prisma.periods.findMany(),
      prisma.profiles.findMany({ select: { id: true, email: true, department_id: true, position: true, role: true } }),
      prisma.courses.findMany({ select: { id: true, name: true } }),
      prisma.course_editions.findMany({ select: { id: true, course_id: true, start_date: true, end_date: true } }),
      prisma.budgets.findMany(),
    ]);

    const plan = { create: {}, reuse: {}, update: {} };
    const mark = (bucket, table) => { plan[bucket][table] = (plan[bucket][table] || 0) + 1; };

    const deptByName = new Map(dbDepts.map((d) => [normName(d.name), d]));
    const instByName = new Map(dbInsts.map((i) => [normName(i.name), i]));
    const profByEmail = new Map(dbProfiles.map((p) => [p.email.toLowerCase(), p]));
    const courseByName = new Map(dbCourses.map((c) => [normName(c.name), c]));
    // Llave natural de edición: course_id + start + end (verificado único en el workbook)
    const ymd = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const editionKeyOf = (courseId, start, end) => `${courseId}|${ymd(start)}|${ymd(end)}`;
    const editionByNatKey = new Map(dbEditions.map((e) => [editionKeyOf(e.course_id, e.start_date, e.end_date), e]));
    const periodByKey = new Map(dbPeriods.map((p) => [`${p.year}|${p.semester ?? ''}`, p]));

    for (const d of data.departments) mark(deptByName.has(normName(d.name)) ? 'reuse' : 'create', 'departments');
    for (const i of data.institutions) mark(instByName.has(normName(i.name)) ? 'reuse' : 'create', 'institutions');
    for (const p of data.periods) mark(periodByKey.has(`${p.year}|`) ? 'reuse' : 'create', 'periods');
    for (const p of data.profiles) {
      const ex = profByEmail.get(p.email);
      if (ex) { mark('reuse', 'profiles'); console.log(`  ↺ Perfil existente, se reusa: ${p.email} (role=${ex.role}, no se toca)`); }
      else mark('create', 'profiles');
    }
    for (const c of data.courses) mark(courseByName.has(normName(c.name)) ? 'reuse' : 'create', 'courses');
    for (const e of data.editions) {
      const dbCourse = courseByName.get(normName(e.course));
      const exists = dbCourse && editionByNatKey.has(editionKeyOf(dbCourse.id, e.start_date, e.end_date));
      mark(exists ? 'reuse' : 'create', 'course_editions');
    }
    // enrollments/budgets/user_roles se resuelven dentro de la transacción (necesitan IDs nuevos)

    console.log('\nPlan (catálogos/perfiles/cursos/ediciones):');
    for (const bucket of ['create', 'reuse']) {
      console.log(`  ${bucket}: ${JSON.stringify(plan[bucket])}`);
    }
    console.log(`  enrollments a procesar: ${data.enrollments.length} (upsert por (edition, profile))`);
    console.log(`  budgets a procesar: ${data.budgets.length} (match por (department, period))`);

    printWarnings();

    if (MODE === 'dry-run') {
      console.log('\nDRY-RUN: no se escribió nada. Ejecuta con --commit para importar.');
      return;
    }

    // ---------- COMMIT ----------
    console.log('\nEjecutando importación en transacción...');
    const result = await prisma.$transaction(async (tx) => {
      const counts = { departments: 0, institutions: 0, periods: 0, profiles: 0, user_roles: 0, courses: 0, course_editions: 0, course_enrollments: 0, budgets: 0 };

      const deptId = new Map();
      for (const d of data.departments) {
        const row = await tx.departments.upsert({
          where: { name: d.name },
          update: {},
          create: { name: d.name, is_active: d.is_active },
        });
        deptId.set(normName(d.name), row.id);
        counts.departments++;
      }

      const instId = new Map();
      for (const i of data.institutions) {
        const row = await tx.institutions.upsert({
          where: { name: i.name },
          update: {},
          create: { name: i.name, type: i.type, is_platform: i.is_platform, is_active: i.is_active },
        });
        instId.set(normName(i.name), row.id);
        counts.institutions++;
      }

      const periodId = new Map();
      for (const p of data.periods) {
        // (year, semester=NULL): el unique compuesto no aplica con NULL en PG → findFirst
        let row = await tx.periods.findFirst({ where: { year: p.year, semester: null } });
        if (!row) {
          row = await tx.periods.create({
            data: { year: p.year, semester: null, label: p.label, start_date: asDate(p.start_date), end_date: asDate(p.end_date) },
          });
        }
        periodId.set(p.year, row.id);
        counts.periods++;
      }

      const profId = new Map();
      for (const p of data.profiles) {
        const existing = await tx.profiles.findUnique({ where: { email: p.email } });
        let row;
        if (existing) {
          // Solo completar huecos; NUNCA tocar role / is_active de un perfil existente
          const patch = {};
          if (!existing.department_id && p.department) patch.department_id = deptId.get(normName(p.department));
          if (!existing.position && p.position) patch.position = p.position;
          row = Object.keys(patch).length
            ? await tx.profiles.update({ where: { id: existing.id }, data: patch })
            : existing;
        } else {
          row = await tx.profiles.create({
            data: {
              full_name: p.full_name,
              email: p.email,
              position: p.position,
              department_id: p.department ? deptId.get(normName(p.department)) : null,
              is_active: p.is_active,
              deactivated_at: p.is_active ? null : new Date(),
              // role: default 'collaborator'; pending_first_login: default true (K-7)
            },
          });
        }
        profId.set(p.email, row.id);
        counts.profiles++;

        // Rol capacitacion/colaborador: solo activos y solo si no tienen ya rol activo en el módulo
        if (p.is_active) {
          const hasRole = await tx.user_roles.findFirst({
            where: { profile_id: row.id, module: 'capacitacion', is_active: true },
          });
          if (!hasRole) {
            await tx.user_roles.create({
              data: { profile_id: row.id, module: 'capacitacion', role: 'colaborador' },
            });
            counts.user_roles++;
          }
        }
      }

      const courseId = new Map();
      for (const c of data.courses) {
        let row = await tx.courses.findFirst({ where: { name: { equals: c.name, mode: 'insensitive' } } });
        if (!row) {
          row = await tx.courses.create({
            data: {
              name: c.name,
              institution_id: c.institution ? instId.get(normName(c.institution)) : null,
              total_hours: c.total_hours,
              cost: c.cost,
              description: c.description,
            },
          });
        }
        courseId.set(normName(c.name), row.id);
        counts.courses++;
      }

      const editionId = new Map();
      for (const e of data.editions) {
        const cId = courseId.get(normName(e.course));
        let row = await tx.course_editions.findFirst({
          where: { course_id: cId, start_date: asDate(e.start_date), end_date: asDate(e.end_date) },
        });
        if (!row) {
          row = await tx.course_editions.create({
            data: {
              course_id: cId,
              start_date: asDate(e.start_date),
              end_date: asDate(e.end_date),
              cost_override: e.cost_override,
              prorate_cost: e.prorate_cost,
              payment_status: e.payment_status,
              payment_reference: e.payment_reference,
              payment_date: asDate(e.payment_date),
              require_evidence_for_completion: e.require_evidence_for_completion,
            },
          });
        }
        editionId.set(e.edition_key, row.id);
        counts.course_editions++;
      }

      for (const en of data.enrollments) {
        const ceId = editionId.get(en.edition_key);
        const pId = profId.get(en.email);
        await tx.course_enrollments.upsert({
          where: { course_edition_id_profile_id: { course_edition_id: ceId, profile_id: pId } },
          update: {},
          create: {
            course_edition_id: ceId,
            profile_id: pId,
            status: en.status,
            enrolled_at: asTs(en.enrolled_at) || new Date(),
            completed_at: asTs(en.completed_at),
            notes: en.notes,
          },
        });
        counts.course_enrollments++;
      }

      for (const b of data.budgets) {
        const dId = deptId.get(normName(b.department));
        const perId = periodId.get(b.year);
        const existing = await tx.budgets.findFirst({ where: { department_id: dId, period_id: perId } });
        if (existing) {
          await tx.budgets.update({
            where: { id: existing.id },
            data: { assigned_amount: b.assigned_amount, consumed_amount: b.consumed_amount },
          });
        } else {
          await tx.budgets.create({
            data: { department_id: dId, period_id: perId, assigned_amount: b.assigned_amount, consumed_amount: b.consumed_amount },
          });
        }
        counts.budgets++;
      }

      return counts;
    }, { timeout: 180_000, maxWait: 15_000 });

    console.log('\nProcesado (create+reuse) por tabla:', JSON.stringify(result, null, 2));

    // Verificación post-commit
    const verify = {
      departments: await prisma.departments.count(),
      institutions: await prisma.institutions.count(),
      periods: await prisma.periods.count(),
      profiles: await prisma.profiles.count(),
      user_roles_capacitacion: await prisma.user_roles.count({ where: { module: 'capacitacion', is_active: true } }),
      courses: await prisma.courses.count(),
      course_editions: await prisma.course_editions.count(),
      course_enrollments: await prisma.course_enrollments.count(),
      enrollments_by_status: undefined,
      budgets: await prisma.budgets.count(),
    };
    const byStatus = await prisma.course_enrollments.groupBy({ by: ['status'], _count: true });
    verify.enrollments_by_status = Object.fromEntries(byStatus.map((s) => [s.status, s._count]));
    console.log('\nConteos totales en BD tras importación:', JSON.stringify(verify, null, 2));
    console.log('\nEsperado (BD que solo tenía 2 perfiles): 8 depts, 25 inst, 1 period, 47 profiles,');
    console.log('35 courses, 40 editions, 61 enrollments (30 completo/17 en_curso/9 pendiente_evidencia/5 inscrito), 8 budgets.');
  } finally {
    await prisma.$disconnect();
  }
}

function printWarnings() {
  console.log(`\nWarnings (${warnings.length}):`);
  for (const w of warnings) console.log('  ⚠ ' + w);
}

run().catch((e) => {
  console.error('\nFALLO — no se aplicó nada (transacción revertida si estaba en commit):');
  console.error(e);
  process.exit(1);
});

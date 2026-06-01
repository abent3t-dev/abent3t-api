// scripts/migrate-data.mjs
//
// Extrae los datos del proyecto Supabase remoto vía PostgREST y genera
// `prisma/sql/0003_seed_data.sql` con INSERTs en orden topológico de FK.
//
// Uso:
//   node scripts/migrate-data.mjs
//
// Requisitos:
//   * .env con SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY (ya existe).
//   * Node 18+ (fetch nativo). El proyecto tiene Node 22.
//
// Notas:
//   * Solo lee del remoto; nunca escribe. El archivo SQL resultante se aplica
//     a mano con psql contra el PG16 local (ver MIGRATION.md §2.2-4).
//   * Las tablas vacías se omiten (con `-- <table>: empty`).
//   * El orden topológico respeta las FKs reales de 0001_baseline_schema.sql.
//   * Los timestamps/UUIDs/JSON se serializan como strings y Postgres hace
//     cast implícito desde el tipo de la columna (no necesita `::jsonb`).
//   * El SQL generado va dentro de BEGIN/COMMIT — si una fila falla, todo
//     se hace rollback.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dirname, '..');
const SQL_OUT  = resolve(API_ROOT, 'prisma', 'sql', '0003_seed_data.sql');

// ---- Read .env ---------------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(resolve(API_ROOT, '.env'), 'utf-8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    }),
);
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Falta SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

// ---- Orden topológico (FK-safe). Solo tablas con count > 0 al 2026-05-31. ----
// Las vacías se incluyen como comentario y se saltan en runtime.
const TABLES_ORDER = [
  // Nivel 0 (sin FK a profiles)
  'departments',
  'institutions',
  'course_types',
  'modalities',
  'periods',
  'purchase_types',
  'holidays',
  'inpc_factors',                    // empty
  'sap_connections',                 // empty
  'sat_credentials',                 // empty
  'sat_declarations',                // empty
  'cfdis',                           // empty
  'sync_logs',                       // empty
  // Nivel 1 (depende de departments)
  'profiles',
  // Nivel 2 (depende de profiles)
  'user_roles',
  'audit_logs',
  'courses',
  'suppliers',
  'accounting_okrs',                 // empty
  'fiscal_losses',                   // empty
  'non_deductibles',                 // empty
  'payment_complement_reconciliation', // empty
  'platform_integrations',
  'shareholding_records',            // empty
  // Nivel 3
  'course_editions',
  'budgets',
  'platform_courses',
  'platform_user_mappings',
  'requisitions',                    // empty
  'fiscal_loss_amortizations',       // empty
  'shareholding_detail',             // empty
  // Nivel 4
  'course_enrollments',
  'platform_enrollments',
  'platform_sync_logs',
  'purchase_orders',                 // empty
  'approval_workflows',              // empty
  'requisition_history',             // empty
  // Nivel 5
  'enrollment_evidences',
  'training_requests',
  'course_proposals',
  'approvals',                       // empty
  // Nivel 6
  'proposal_attachments',
];

// ---- Helpers de escape ------------------------------------------------------
function escapeLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'NULL';
    return String(v);
  }
  if (typeof v === 'object') {
    // Arrays y objects → JSON string. Postgres hace cast desde text a jsonb.
    return `'${JSON.stringify(v).replaceAll("'", "''")}'`;
  }
  // string (incluye UUIDs, ISO timestamps, fechas, varchar, text)
  return `'${String(v).replaceAll("'", "''")}'`;
}

function quoteIdent(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

// ---- Fetch PostgREST con paginación por Range header -----------------------
// Supabase PostgREST devuelve max 1000 filas por request por defecto. Usamos
// Range para paginar y `Prefer: count=exact` para conocer el total.
async function fetchAllRows(table) {
  const pageSize = 1000;
  const rows = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=*&order=id.asc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} fetching ${table}: ${body.slice(0, 200)}`);
    }
    const chunk = await res.json();
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

// ---- Algunas tablas no tienen `id` como PK — usar otra columna para order ---
const ORDER_BY_OVERRIDE = {
  inpc_factors: 'year',
  // todas las demás tienen `id` (uuid PK)
};

async function fetchAllRowsSmart(table) {
  // Para evitar ESLint/correctness: si la tabla no tiene `id`, usamos override.
  const orderCol = ORDER_BY_OVERRIDE[table] || 'id';
  const pageSize = 1000;
  const rows = [];
  let offset = 0;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?select=*&order=${orderCol}.asc&limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status} fetching ${table}: ${body.slice(0, 200)}`);
    }
    const chunk = await res.json();
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

// ---- Main -------------------------------------------------------------------
async function main() {
  mkdirSync(dirname(SQL_OUT), { recursive: true });

  const header = `-- =============================================================================
-- 0003_seed_data.sql
-- Snapshot de datos del Supabase remoto al 2026-05-31, en orden FK-safe.
-- Generado por scripts/migrate-data.mjs. NO editar a mano — re-ejecutar el
-- script si los datos cambian.
--
-- Aplicar con:
--   psql -U postgres -h localhost -p 5433 -d abent3t_db \\
--        -v ON_ERROR_STOP=1 -f abent3t-api/prisma/sql/0003_seed_data.sql
--
-- IMPORTANTE: este archivo asume que 0001_baseline_schema.sql y
-- 0002_local_credentials.sql ya se aplicaron y que el esquema está vacío
-- (sin filas en ninguna tabla). Si re-ejecutas, primero TRUNCATE las tablas
-- en orden inverso o RECREATE el esquema.
-- =============================================================================

BEGIN;

-- Postgres respeta los DEFAULTs cuando no especificas la columna; aquí
-- pasamos TODAS las columnas explícitamente para fidelidad bit-a-bit con
-- el snapshot remoto (incluyendo created_at, updated_at, etc.).
`;

  let out = header;
  let totalRows = 0;
  let totalTables = 0;

  for (const table of TABLES_ORDER) {
    process.stderr.write(`Fetching ${table}... `);
    const rows = await fetchAllRowsSmart(table);
    process.stderr.write(`${rows.length} rows\n`);

    if (rows.length === 0) {
      out += `\n-- ${table}: empty (sin datos en remoto)\n`;
      continue;
    }

    totalTables += 1;
    totalRows += rows.length;
    const cols = Object.keys(rows[0]);
    const colList = cols.map(quoteIdent).join(', ');
    out += `\n-- ${table} (${rows.length} rows)\n`;
    for (const r of rows) {
      const vals = cols.map((c) => escapeLiteral(r[c])).join(', ');
      out += `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${vals});\n`;
    }
  }

  out += `\nCOMMIT;\n\n-- Total: ${totalTables} tablas, ${totalRows} filas.\n`;
  writeFileSync(SQL_OUT, out);
  console.error(`\n✅ Generado ${SQL_OUT}`);
  console.error(`   ${totalTables} tablas con datos, ${totalRows} filas totales.`);
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});

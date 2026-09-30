/**
 * Fase §15 (regla 7) — importación del Excel de contratos de Ingrid/Diana a
 * la tabla `contracts`. Script, NO endpoint. La lógica (columnas, cambios y
 * faltantes) vive en src/contracts/contracts-import.plan.ts, con pruebas.
 *
 * Formato del 21-sep (CONTROL_DE_CONTRATOS.xlsx, hoja "Control de contratos"):
 *   # | Contrato | Proveedor | Descrip. | Fecha Inicio | Fecha Fin |
 *   Fecha real | Resp. Usuario | Disp. | Adm. de Contrato | Documento
 * Si la base depurada trae además Monto, Moneda, Consumido, Link, Tomo, Tipo
 * o Correo del responsable, se toman (ver los alias en el plan).
 *
 * H2 (2026-09-29, base depurada de Diana):
 *  - `--update`: además de las altas, revisa los contratos que ya existen
 *    campo por campo. Solo cambia lo que el archivo TRAE: nunca pisa con
 *    vacíos lo capturado en la UI (link, consumido, monto). Las notas no se
 *    reescriben; lo nuevo del Excel se agrega al final.
 *  - El reporte lista nuevos, cambios campo por campo, sin cambios y los
 *    contratos de la base que ya no vienen en el archivo (candidatos a baja).
 *  - `--deactivate-missing` (con `--update --commit`): baja lógica
 *    (is_active=false) de esos faltantes, salvo los capturados en la
 *    plataforma, que se listan para revisarlos a mano.
 *  - `--moneda=MXN`: moneda para montos que vengan sin moneda (si no, esos
 *    montos no se importan: nunca se inventa la moneda).
 *
 * Reglas de siempre: proveedor por nombre (exacto y prefijo único; si no
 * existe, alta manual con RFC placeholder SIN-RFC-…), estatus por fecha de
 * fin, "Disp." no se importa, PDFs no se cargan aquí.
 *
 * USO (default = DRY-RUN, no escribe nada):
 *   npm run contracts:import-excel -- <ruta.xlsx>
 *   npm run contracts:import-excel -- <ruta.xlsx> --update
 *   npm run contracts:import-excel -- <ruta.xlsx> --update --commit
 *   npm run contracts:import-excel -- <ruta.xlsx> --update --deactivate-missing --commit
 *
 * GUARD: se niega a correr con NODE_ENV=production (regla 7). La carga a la
 * BD de prod se hace desde un contenedor efímero o una máquina de trabajo
 * apuntando DATABASE_URL a prod (mecánica del 2026-09-22).
 */
import { readFileSync } from 'fs';
import { basename, extname } from 'path';
import * as XLSX from 'xlsx';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  compact,
  type ContractImportPlan,
  type ExistingContract,
  normalizeContractRows,
  placeholderTaxId,
  planContractImport,
} from '../src/contracts/contracts-import.plan';

const FIELD_LABELS: Record<string, string> = {
  service_description: 'descripción',
  supplier: 'proveedor',
  start_date: 'inicio',
  end_date: 'fin',
  status: 'estatus',
  responsible_user_name: 'responsable',
  responsible_user_email: 'correo del responsable',
  total_amount: 'monto',
  currency: 'moneda',
  consumed_amount: 'consumido',
  external_link: 'link',
  tomo: 'tomo',
  document_type: 'tipo',
  notes: 'notas',
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

function readRecords(filePath: string): Array<Record<string, unknown>> {
  const workbook = XLSX.read(readFileSync(filePath), {
    type: 'buffer',
    cellDates: true,
  });
  const sheetName =
    workbook.SheetNames.find((n) => compact(n) === 'CONTROLDECONTRATOS') ??
    workbook.SheetNames[0];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(
    workbook.Sheets[sheetName],
    { defval: undefined, blankrows: false },
  );
}

function printReport(plan: ContractImportPlan, mode: string) {
  console.log(`\n=== Importación de contratos (${mode}) ===`);
  console.log(`\nNuevos (${plan.create.length}):`);
  for (const c of plan.create) {
    console.log(
      `  ${c.data.status.toUpperCase().padEnd(8)} | ${c.data.contract_number} | ${isoDay(c.data.start_date)} → ${isoDay(c.data.end_date)} | ${c.row.supplierName} (${c.supplierNote})`,
    );
  }
  console.log(`\nPor actualizar (${plan.update.length}):`);
  for (const u of plan.update) {
    console.log(`  ${u.row.number}`);
    for (const ch of u.changes) {
      const from = ch.from === null ? 'vacío' : `"${ch.from}"`;
      console.log(
        `     ${FIELD_LABELS[ch.field] ?? ch.field}: ${from} → "${ch.to}"`,
      );
    }
  }
  console.log(
    `\nSin cambios (${plan.unchanged.length})${plan.unchanged.length ? ': ' + plan.unchanged.join(', ') : ''}`,
  );
  if (plan.skipped.length > 0) {
    console.log(
      `\nYa existían, no revisados (${plan.skipped.length}; usa --update para revisarlos): ${plan.skipped.join(', ')}`,
    );
  }
  if (plan.missing.length > 0 || mode.includes('update')) {
    console.log(
      `\nEn la base y NO en el archivo (${plan.missing.length}) — candidatos a baja:`,
    );
    for (const m of plan.missing) {
      console.log(
        `  ${m.contract_number} | ${m.supplier_name} | fin ${isoDay(m.end_date)}${m.fromPlatform ? ' | capturado en la plataforma: revisar a mano (no se da de baja)' : ''}`,
      );
    }
  }
  if (plan.warnings.length > 0) {
    console.log(`\nAdvertencias (${plan.warnings.length}):`);
    for (const w of plan.warnings) console.log('  - ' + w);
  }
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Guard de seguridad: este script de carga no corre con NODE_ENV=production (regla 7 de la fase §15)',
    );
  }
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const update = args.includes('--update');
  const deactivate = args.includes('--deactivate-missing');
  const currencyArg = args.find((a) => a.startsWith('--moneda='));
  const filePath = args.find((a) => !a.startsWith('--'));
  if (!filePath) {
    throw new Error(
      'Falta la ruta del Excel. Uso: npm run contracts:import-excel -- <ruta.xlsx> [--update] [--deactivate-missing] [--moneda=MXN] [--commit]',
    );
  }
  if (deactivate && !update) {
    throw new Error(
      '--deactivate-missing va con --update (primero se revisa el archivo completo)',
    );
  }

  const { rows, warnings } = normalizeContractRows(readRecords(filePath));
  const today = new Date();
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const [contracts, suppliers] = await Promise.all([
      prisma.contracts.findMany({
        where: { is_active: true },
        include: { suppliers: { select: { legal_name: true } } },
      }),
      prisma.suppliers.findMany({
        where: { is_active: true },
        select: { id: true, legal_name: true },
      }),
    ]);
    const existing: ExistingContract[] = contracts.map((c) => ({
      id: c.id,
      contract_number: c.contract_number,
      tomo: c.tomo,
      document_type: c.document_type,
      service_description: c.service_description,
      supplier_id: c.supplier_id,
      supplier_name: c.suppliers.legal_name,
      start_date: c.start_date,
      end_date: c.end_date,
      total_amount: c.total_amount === null ? null : Number(c.total_amount),
      currency: c.currency,
      consumed_amount:
        c.consumed_amount === null ? null : Number(c.consumed_amount),
      external_link: c.external_link,
      responsible_user_name: c.responsible_user_name,
      responsible_user_email: c.responsible_user_email,
      status: c.status,
      notes: c.notes,
      created_by: c.created_by,
    }));
    const label = `Importado del Excel ${basename(filePath, extname(filePath))} (${isoDay(today)}).`;
    const plan = planContractImport({
      rows,
      existing,
      suppliers: suppliers.map((s) => ({
        id: s.id,
        legal_name: s.legal_name,
        key: compact(s.legal_name),
      })),
      options: {
        today,
        update,
        defaultCurrency: currencyArg
          ? currencyArg.slice('--moneda='.length).toUpperCase()
          : null,
        importLabel: label,
      },
    });
    plan.warnings.unshift(...warnings);

    const mode = `${commit ? 'COMMIT' : 'DRY-RUN — nada escrito; agrega --commit'}${update ? ' · update' : ''}${deactivate ? ' · deactivate-missing' : ''}`;
    printReport(plan, mode);
    if (plan.errors.length > 0) {
      console.error(
        `\nErrores (${plan.errors.length}) — esas filas no se tocan:`,
      );
      for (const err of plan.errors) console.error('  - ' + err);
      process.exitCode = 1;
    }

    const toDeactivate = deactivate
      ? plan.missing.filter((m) => !m.fromPlatform)
      : [];
    let suppliersCreated = 0;
    if (commit) {
      await prisma.$transaction(
        async (tx) => {
          // Proveedores nuevos: uno por nombre, aunque vengan en varias filas
          const newSupplier = new Map<string, string>();
          const supplierId = async (data: {
            supplier_id?: string;
            new_supplier_name?: string;
          }) => {
            if (data.supplier_id) return data.supplier_id;
            const name = data.new_supplier_name as string;
            const known = newSupplier.get(name);
            if (known) return known;
            const created = await tx.suppliers.create({
              data: {
                legal_name: name,
                tax_id: placeholderTaxId(name),
                source: 'manual',
              },
              select: { id: true },
            });
            newSupplier.set(name, created.id);
            suppliersCreated += 1;
            return created.id;
          };
          for (const c of plan.create) {
            const {
              new_supplier_name: _ignored,
              supplier_id: _id,
              ...data
            } = c.data;
            await tx.contracts.create({
              data: { ...data, supplier_id: await supplierId(c.data) },
            });
          }
          for (const u of plan.update) {
            const {
              new_supplier_name: _ignored,
              supplier_id: _id,
              ...data
            } = u.data;
            const changesSupplier =
              u.data.supplier_id !== undefined ||
              u.data.new_supplier_name !== undefined;
            await tx.contracts.update({
              where: { id: u.id },
              data: {
                ...data,
                ...(changesSupplier
                  ? { supplier_id: await supplierId(u.data) }
                  : {}),
              },
            });
          }
          for (const m of toDeactivate) {
            await tx.contracts.update({
              where: { id: m.id },
              data: { is_active: false, deleted_at: new Date() },
            });
          }
        },
        { timeout: 120_000 },
      );
    }

    console.log(
      `\nResumen: ${plan.create.length} ${commit ? 'creados' : 'por crear'} · ${plan.update.length} ${commit ? 'actualizados' : 'por actualizar'} · ${plan.unchanged.length} sin cambios · ${plan.missing.length} faltantes` +
        (deactivate
          ? ` (${toDeactivate.length} ${commit ? 'dados de baja' : 'se darían de baja'})`
          : '') +
        (commit ? ` · proveedores dados de alta: ${suppliersCreated}` : ''),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('contracts:import-excel falló:', err);
  process.exitCode = 1;
});

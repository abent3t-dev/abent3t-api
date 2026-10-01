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
 * I6 (go-live 2026-09-30) — la base REAL (Control_de_contratos_A3T.xlsx):
 *  - la hoja es la que trae los encabezados ("Hoja2" son los catálogos y va
 *    primero); las fechas se leen como seriales (no dependen de la zona
 *    horaria de la máquina) o texto `dd/mm/aaaa`;
 *  - número = carpeta + tipo (A3T-0003, A3T-0003-CI, A3T-0003-E1…);
 *  - un proveedor nuevo cuyo `SIN-RFC-…` ya existe inactivo (los del Excel
 *    de ejemplo) se REACTIVA en lugar de crearse (tax_id es UNIQUE);
 *  - con `--deactivate-missing`, además de los contratos faltantes se dan de
 *    baja los proveedores `SIN-RFC-…` que se queden sin contratos activos ni
 *    OC, y se reportan;
 *  - al final, el reporte para Diana (proveedores sin match, filas
 *    saltadas, montos sin moneda, fechas ilegibles, sin fecha de fin y
 *    estatus del Excel que contradicen la fecha).
 *
 * Reglas de siempre: proveedor por nombre (exacto, sin forma jurídica y
 * prefijo único; si no existe, alta manual con RFC placeholder SIN-RFC-…),
 * estatus por fecha de fin, "Disp." no se importa, PDFs no se cargan aquí.
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
  type NormalizeResult,
  normalizeContractRows,
  pickContractSheet,
  placeholderTaxId,
  planContractImport,
  supplierNormKey,
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
  carpeta: 'carpeta',
  document_label: 'documento',
  user_area: 'área usuaria',
  buyer_profile_id: 'comprador',
};

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

function readRecords(filePath: string): {
  sheet: string;
  records: Array<Record<string, unknown>>;
} {
  // Sin cellDates: los seriales no dependen de la zona horaria de la máquina
  const workbook = XLSX.read(readFileSync(filePath), {
    type: 'buffer',
    cellDates: false,
  });
  const sheets = workbook.SheetNames.map((name) => ({
    name,
    headers:
      XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
        header: 1,
        blankrows: false,
      })[0] ?? [],
  }));
  const sheet =
    workbook.SheetNames.find((n) => compact(n) === 'CONTROLDECONTRATOS') ??
    pickContractSheet(sheets);
  if (!sheet) {
    throw new Error(
      `Ninguna hoja trae los encabezados de contratos (Proveedor y Carpeta o Contrato): ${workbook.SheetNames.join(', ')}`,
    );
  }
  return {
    sheet,
    records: XLSX.utils.sheet_to_json<Record<string, unknown>>(
      workbook.Sheets[sheet],
      { defval: undefined, blankrows: false },
    ),
  };
}

function printReport(
  plan: ContractImportPlan,
  normalized: NormalizeResult,
  mode: string,
  extras: {
    reactivates: Map<string, string>;
    suppliersToDeactivate: Array<{ legal_name: string; tax_id: string }>;
    deactivate: boolean;
  },
) {
  console.log(`\n=== Importación de contratos (${mode}) ===`);
  console.log(`\nNuevos (${plan.create.length}):`);
  for (const c of plan.create) {
    console.log(
      `  ${c.data.status.toUpperCase().padEnd(8)} | ${c.data.contract_number.padEnd(14)} | ${isoDay(c.data.start_date)} → ${isoDay(c.data.end_date)} | ${c.row.supplierName} (${c.supplierNote})`,
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
  if (extras.deactivate) {
    console.log(
      `\nProveedores SIN-RFC que se quedan sin contratos activos ni OC (${extras.suppliersToDeactivate.length}) — se dan de baja:`,
    );
    for (const s of extras.suppliersToDeactivate) {
      console.log(`  ${s.legal_name} (${s.tax_id})`);
    }
  }
  if (plan.warnings.length > 0) {
    console.log(`\nAdvertencias (${plan.warnings.length}):`);
    for (const w of plan.warnings) console.log('  - ' + w);
  }

  // ── I6: reporte para Diana ──
  const r = plan.report;
  console.log('\n=== Reporte para Diana ===');
  console.log(
    `\nProveedores sin match en el catálogo (${r.newSuppliers.length}) — se dan de alta manuales:`,
  );
  for (const s of r.newSuppliers) {
    const variants =
      s.variants.length > 1 ? ` · variantes: ${s.variants.join(' / ')}` : '';
    const reactivated = extras.reactivates.get(s.name);
    console.log(
      `  ${s.name} (${s.rows.length} doc.: ${s.rows.join(', ')})${variants}${reactivated ? ` · se REACTIVA ${reactivated} (estaba inactivo)` : ''}`,
    );
  }
  console.log(
    `\nFilas saltadas (${normalized.skipped.length}) — sin proveedor ni servicio:`,
  );
  for (const s of normalized.skipped) {
    console.log(`  Fila ${s.rowNumber}: ${s.ref}`);
  }
  console.log(
    `\nMontos sin moneda (${r.amountWithoutCurrency.length}) — no se importan:`,
  );
  for (const a of r.amountWithoutCurrency) console.log(`  ${a}`);
  console.log(
    `\nFechas que no se pudieron leer (${normalized.unreadableDates.length}) — se importan vacías:`,
  );
  for (const d of normalized.unreadableDates) {
    console.log(`  Fila ${d.rowNumber} (${d.ref}) · ${d.field}: "${d.value}"`);
  }
  if (normalized.unknownAreas.length > 0) {
    console.log(
      `\nÁreas fuera del catálogo (${normalized.unknownAreas.length}) — se guardan tal cual:`,
    );
    for (const a of normalized.unknownAreas) {
      console.log(`  Fila ${a.rowNumber} (${a.ref}): "${a.value}"`);
    }
  }
  console.log(
    `\nDocumentos sin fecha de fin (${r.noEndDate.length}) — sin alertas de vencimiento: ${r.noEndDate.join(', ')}`,
  );
  console.log(
    `\nEstatus del Excel que contradice la fecha de fin (${r.statusContradictions.length}) — manda la fecha:`,
  );
  for (const s of r.statusContradictions) {
    console.log(`  ${s.ref}: Excel "${s.excel}", fin ${s.end} → ${s.byDate}`);
  }
  if (r.unmatchedBuyers.length > 0) {
    console.log(
      `\nCompradores sin usuario en la plataforma (${r.unmatchedBuyers.length}):`,
    );
    for (const b of r.unmatchedBuyers) console.log(`  ${b.ref}: "${b.name}"`);
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

  const { sheet, records } = readRecords(filePath);
  const normalized = normalizeContractRows(records);
  console.log(
    `Hoja "${sheet}": ${records.length} filas, ${normalized.rows.length} documentos importables`,
  );
  const today = new Date();
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const [contracts, suppliers, inactivePlaceholders, profiles] =
      await Promise.all([
        prisma.contracts.findMany({
          where: { is_active: true },
          include: { suppliers: { select: { legal_name: true } } },
        }),
        prisma.suppliers.findMany({
          where: { is_active: true },
          select: { id: true, legal_name: true },
        }),
        prisma.suppliers.findMany({
          where: { is_active: false, tax_id: { startsWith: 'SIN-RFC-' } },
          select: { tax_id: true },
        }),
        prisma.profiles.findMany({
          where: { is_active: true },
          select: { id: true, full_name: true },
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
      carpeta: c.carpeta,
      document_label: c.document_label,
      user_area: c.user_area,
      buyer_profile_id: c.buyer_profile_id,
    }));
    const label = `Importado del Excel ${basename(filePath, extname(filePath))} (${isoDay(today)}).`;
    const plan = planContractImport({
      rows: normalized.rows,
      existing,
      suppliers: suppliers.map((s) => ({
        id: s.id,
        legal_name: s.legal_name,
        key: compact(s.legal_name),
        norm: supplierNormKey(s.legal_name),
      })),
      buyers: profiles
        .filter((p) => p.full_name)
        .map((p) => ({ id: p.id, full_name: p.full_name as string })),
      options: {
        today,
        update,
        defaultCurrency: currencyArg
          ? currencyArg.slice('--moneda='.length).toUpperCase()
          : null,
        importLabel: label,
      },
    });
    plan.warnings.unshift(...normalized.warnings);

    // Proveedores nuevos que reactivan un SIN-RFC inactivo (misma llave)
    const inactive = new Set(inactivePlaceholders.map((s) => s.tax_id));
    const reactivates = new Map<string, string>();
    for (const s of plan.report.newSuppliers) {
      const taxId = placeholderTaxId(s.name);
      if (inactive.has(taxId)) reactivates.set(s.name, taxId);
    }

    const toDeactivate = deactivate
      ? plan.missing.filter((m) => !m.fromPlatform)
      : [];

    // SIN-RFC que se quedan sin contratos activos ni OC (después de la baja)
    const supplierUsedByPlan = new Set(
      [...plan.create, ...plan.update]
        .map((c) => c.data.supplier_id)
        .filter((id): id is string => !!id),
    );
    const leavingIds = new Set(toDeactivate.map((m) => m.id));
    const placeholderSuppliers = deactivate
      ? await prisma.suppliers.findMany({
          where: { is_active: true, tax_id: { startsWith: 'SIN-RFC-' } },
          select: {
            id: true,
            legal_name: true,
            tax_id: true,
            contracts: { where: { is_active: true }, select: { id: true } },
            _count: { select: { purchase_orders: true } },
          },
        })
      : [];
    const suppliersToDeactivate = placeholderSuppliers.filter(
      (s) =>
        s._count.purchase_orders === 0 &&
        !supplierUsedByPlan.has(s.id) &&
        s.contracts.every((c) => leavingIds.has(c.id)),
    );

    const mode = `${commit ? 'COMMIT' : 'DRY-RUN — nada escrito; agrega --commit'}${update ? ' · update' : ''}${deactivate ? ' · deactivate-missing' : ''}`;
    printReport(plan, normalized, mode, {
      reactivates,
      suppliersToDeactivate,
      deactivate,
    });
    if (plan.errors.length > 0) {
      console.error(
        `\nErrores (${plan.errors.length}) — esas filas no se tocan:`,
      );
      for (const err of plan.errors) console.error('  - ' + err);
      process.exitCode = 1;
    }

    let suppliersCreated = 0;
    let suppliersReactivated = 0;
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
            const taxId = placeholderTaxId(name);
            // I6: el SIN-RFC del ejemplo (inactivo) se reactiva, no se duplica
            const previous = await tx.suppliers.findUnique({
              where: { tax_id: taxId },
              select: { id: true, is_active: true },
            });
            if (previous) {
              if (!previous.is_active) {
                await tx.suppliers.update({
                  where: { id: previous.id },
                  data: { is_active: true },
                });
                suppliersReactivated += 1;
              }
              newSupplier.set(name, previous.id);
              return previous.id;
            }
            const created = await tx.suppliers.create({
              data: { legal_name: name, tax_id: taxId, source: 'manual' },
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
          for (const s of suppliersToDeactivate) {
            // por si una fila del archivo lo reactivó en esta misma corrida
            if ([...newSupplier.values()].includes(s.id)) continue;
            await tx.suppliers.update({
              where: { id: s.id },
              data: { is_active: false },
            });
          }
        },
        { timeout: 120_000 },
      );
    }

    console.log(
      `\nResumen: ${plan.create.length} ${commit ? 'creados' : 'por crear'} · ${plan.update.length} ${commit ? 'actualizados' : 'por actualizar'} · ${plan.unchanged.length} sin cambios · ${plan.missing.length} faltantes` +
        (deactivate
          ? ` (${toDeactivate.length} ${commit ? 'dados de baja' : 'se darían de baja'}; proveedores SIN-RFC: ${suppliersToDeactivate.length})`
          : '') +
        ` · proveedores nuevos: ${plan.report.newSuppliers.length} (${reactivates.size} reactivan un SIN-RFC inactivo)` +
        (commit
          ? ` · dados de alta: ${suppliersCreated} · reactivados: ${suppliersReactivated}`
          : ''),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('contracts:import-excel falló:', err);
  process.exitCode = 1;
});

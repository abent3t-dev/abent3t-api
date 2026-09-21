/**
 * Fase §15 (regla 7) — carga inicial ÚNICA del Excel de contratos de
 * Ingrid/Diana (`CONTROL_DE_CONTRATOS.xlsx`, hoja "Control de contratos") a
 * la tabla `contracts`. Es un script de una sola vez, NO un endpoint: el
 * Excel queda reemplazado por el sistema.
 *
 * Formato REAL del Excel (recibido 2026-09-21):
 *   # | Contrato | Proveedor | Descrip. | Fecha Inicio | Fecha Fin |
 *   Fecha real | Resp. Usuario | Disp. | Adm. de Contrato | Documento
 *
 * Reglas de mapeo:
 *  - `document_type` = 'contrato' fijo (delegación del 2026-09-21).
 *  - Proveedor: match contra el catálogo (873 de SAP + manuales) por nombre
 *    normalizado COMPACTO (sin acentos/puntuación/espacios), exacto y luego
 *    por prefijo único — los nombres del Excel vienen TRUNCADOS (~30 chars).
 *    Si no existe (los contratos históricos usan proveedores del holding que
 *    NO están en SAP B1), se DA DE ALTA con `source='manual'` y `tax_id`
 *    placeholder `SIN-RFC-…` (único, editable después desde la UI cuando
 *    Diana entregue los RFC reales).
 *  - `status`: 'vencido' si Fecha Fin ya pasó, 'vigente' si no — importar
 *    históricos como 'vigente' haría que el barrido diario de vencimientos
 *    los marcara Y les mandara correo "expired" (ContractExpiryService).
 *  - Monto/moneda NO vienen en el Excel → null (nunca 0 ni una moneda
 *    inventada — regla T10).
 *  - "Disp." (fracción disponible) NO se importa: es el % consumido, fuera
 *    de alcance (depende del ERP — junta 2026-09-17).
 *  - "Fecha real", "Adm. de Contrato" y "Documento" (nombre del PDF en
 *    SharePoint) no tienen columna propia: se preservan en `notes` (el
 *    Documento servirá para el drill-down a SharePoint cuando César dé
 *    permisos).
 *  - Los PDFs NO se cargan aquí: SharePoint pendiente (sin link aún).
 *
 * USO (default = DRY-RUN, no escribe nada):
 *   npm run contracts:import-excel -- "..\\documentation\\CONTROL_DE_CONTRATOS.xlsx"
 *   npm run contracts:import-excel -- "..\\documentation\\CONTROL_DE_CONTRATOS.xlsx" --commit
 *
 * Idempotente: contratos ya existentes (contract_number) se saltan;
 * proveedores se buscan por nombre antes de crear.
 *
 * GUARD: se niega a correr con NODE_ENV=production (regla 7). La carga a la
 * BD de prod se hace desde una máquina de trabajo apuntando DATABASE_URL a
 * prod (misma mecánica que la importación de capacitación 2026-09-10).
 */
import { readFileSync } from 'fs';
import * as XLSX from 'xlsx';
import { PrismaService } from '../src/prisma/prisma.service';

interface ExcelRow {
  number: string;
  supplierName: string;
  service: string;
  startDate: Date;
  endDate: Date;
  realDate: Date | null;
  responsible: string | null;
  admin: string | null;
  documentRef: string | null;
  rowNumber: number;
}

/** Sin acentos, sin puntuación, sin espacios, mayúsculas. */
function compact(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

/** Placeholder de RFC para proveedores históricos sin RFC (tax_id UNIQUE). */
function placeholderTaxId(name: string): string {
  return `SIN-RFC-${compact(name).slice(0, 30)}`.slice(0, 40);
}

/** Fechas del Excel: Date (cellDates), serial numérico o texto. */
function parseExcelDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    // Serial de Excel: días desde 1899-12-30
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value.trim());
    return Number.isNaN(parsed) ? null : new Date(parsed);
  }
  return null;
}

function fmtDate(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : '';
}

/**
 * Lee la hoja tolerando variaciones del encabezado (espacios dobles,
 * mayúsculas): las columnas se resuelven por su nombre normalizado.
 */
function readRows(filePath: string): ExcelRow[] {
  const workbook = XLSX.read(readFileSync(filePath), {
    type: 'buffer',
    cellDates: true,
  });
  const sheetName =
    workbook.SheetNames.find((n) => compact(n) === 'CONTROLDECONTRATOS') ??
    workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: undefined,
    blankrows: false,
  });

  const col = (row: Record<string, unknown>, header: string): unknown => {
    const target = compact(header);
    for (const [key, value] of Object.entries(row)) {
      if (compact(key) === target) return value;
    }
    return undefined;
  };
  const text = (row: Record<string, unknown>, header: string): string => {
    const value = col(row, header);
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    return '';
  };

  const out: ExcelRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const number = text(row, 'Contrato');
    const supplierName = text(row, 'Proveedor');
    if (!number && !supplierName) continue; // fila vacía
    out.push({
      number,
      supplierName,
      service: text(row, 'Descrip.'),
      startDate: parseExcelDate(col(row, 'Fecha Inicio')) as Date,
      endDate: parseExcelDate(col(row, 'Fecha Fin')) as Date,
      realDate: parseExcelDate(col(row, 'Fecha real')),
      responsible: text(row, 'Resp. Usuario') || null,
      admin: text(row, 'Adm. de Contrato') || null,
      documentRef: text(row, 'Documento') || null,
      rowNumber: i + 2, // 1 = encabezados
    });
  }
  return out;
}

interface SupplierIndexEntry {
  id: string;
  legal_name: string;
  key: string;
}

/**
 * Resuelve el proveedor contra el índice en memoria: exacto compacto y
 * después prefijo único (≥10 chars para no matchear por siglas cortas).
 */
function matchSupplier(
  name: string,
  index: SupplierIndexEntry[],
): { entry: SupplierIndexEntry | null; ambiguous: string[] } {
  const key = compact(name);
  const exact = index.filter((s) => s.key === key);
  if (exact.length === 1) return { entry: exact[0], ambiguous: [] };
  if (exact.length > 1) {
    return { entry: null, ambiguous: exact.map((s) => s.legal_name) };
  }
  const byPrefix = index.filter(
    (s) =>
      (key.length >= 10 && s.key.startsWith(key)) ||
      (s.key.length >= 10 && key.startsWith(s.key)),
  );
  if (byPrefix.length === 1) return { entry: byPrefix[0], ambiguous: [] };
  return { entry: null, ambiguous: byPrefix.map((s) => s.legal_name) };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Guard de seguridad: este script de carga inicial no corre con NODE_ENV=production (regla 7 de la fase §15)',
    );
  }
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const filePath = args.find((a) => !a.startsWith('--'));
  if (!filePath) {
    throw new Error(
      'Falta la ruta del Excel. Uso: npm run contracts:import-excel -- <ruta.xlsx> [--commit]',
    );
  }

  const rows = readRows(filePath);
  const prisma = new PrismaService();
  await prisma.$connect();

  let created = 0;
  let skipped = 0;
  let suppliersCreated = 0;
  const errors: string[] = [];
  const report: string[] = [];
  const today = new Date();

  try {
    const supplierRows = await prisma.suppliers.findMany({
      where: { is_active: true },
      select: { id: true, legal_name: true },
    });
    const index: SupplierIndexEntry[] = supplierRows.map((s) => ({
      id: s.id,
      legal_name: s.legal_name,
      key: compact(s.legal_name),
    }));

    for (const row of rows) {
      const where = `Fila ${row.rowNumber} (${row.number || 'sin numero'})`;
      if (!row.number || !row.supplierName || !row.service) {
        errors.push(`${where}: faltan numero/proveedor/descripcion`);
        continue;
      }
      if (!row.startDate || !row.endDate) {
        errors.push(`${where}: vigencia incompleta (Fecha Inicio/Fecha Fin)`);
        continue;
      }

      const existing = await prisma.contracts.findUnique({
        where: { contract_number: row.number },
        select: { id: true },
      });
      if (existing) {
        skipped += 1;
        report.push(`YA EXISTE  | ${row.number} — saltado`);
        continue;
      }

      // Proveedor: match o alta manual
      const match = matchSupplier(row.supplierName, index);
      if (!match.entry && match.ambiguous.length > 0) {
        errors.push(
          `${where}: proveedor "${row.supplierName}" AMBIGUO entre: ${match.ambiguous.join(' / ')}`,
        );
        continue;
      }
      let supplierId = match.entry?.id ?? null;
      let supplierNote: string;
      if (match.entry) {
        supplierNote = `match: ${match.entry.legal_name}`;
      } else {
        supplierNote = 'ALTA manual (no estaba en el catalogo)';
        if (commit) {
          const createdSupplier = await prisma.suppliers.create({
            data: {
              legal_name: row.supplierName,
              tax_id: placeholderTaxId(row.supplierName),
              source: 'manual',
            },
            select: { id: true, legal_name: true },
          });
          supplierId = createdSupplier.id;
          index.push({
            id: createdSupplier.id,
            legal_name: createdSupplier.legal_name,
            key: compact(createdSupplier.legal_name),
          });
        } else {
          // dry-run: registrar el alta simulada para filas siguientes del
          // mismo proveedor (no contarlo dos veces)
          index.push({
            id: 'dry-run',
            legal_name: row.supplierName,
            key: compact(row.supplierName),
          });
          supplierId = 'dry-run';
        }
        suppliersCreated += 1;
      }

      const status = row.endDate < today ? 'vencido' : 'vigente';
      const noteParts = [
        'Importado del Excel CONTROL_DE_CONTRATOS (2026-09-21).',
      ];
      if (row.realDate) {
        noteParts.push(`Fecha real de fin (Excel): ${fmtDate(row.realDate)}.`);
      }
      if (row.admin) noteParts.push(`Adm. de contrato: ${row.admin}.`);
      if (row.documentRef) {
        noteParts.push(`Documento (SharePoint): ${row.documentRef}.`);
      }

      if (commit) {
        try {
          await prisma.contracts.create({
            data: {
              contract_number: row.number,
              document_type: 'contrato',
              service_description: row.service,
              supplier_id: supplierId as string,
              start_date: row.startDate,
              end_date: row.endDate,
              total_amount: null,
              currency: null,
              responsible_user_name: row.responsible,
              status,
              notes: noteParts.join(' '),
            },
          });
        } catch (err: unknown) {
          const code = (err as { code?: string }).code;
          if (code === 'P2002') {
            skipped += 1;
            report.push(`YA EXISTE  | ${row.number} — saltado (P2002)`);
            continue;
          }
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${where}: ${msg.slice(0, 150)}`);
          continue;
        }
      }
      created += 1;
      report.push(
        `${status === 'vencido' ? 'VENCIDO ' : 'VIGENTE '}  | ${row.number} | ${fmtDate(row.startDate)} → ${fmtDate(row.endDate)} | ${row.supplierName} (${supplierNote})`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(
    `\n=== Importación de contratos (${commit ? 'COMMIT' : 'DRY-RUN — nada escrito; agrega --commit'}) ===`,
  );
  for (const line of report) console.log(' ' + line);
  console.log(
    `\nContratos: ${created} ${commit ? 'creados' : 'por crear'} · ${skipped} ya existían · Proveedores dados de alta: ${suppliersCreated}`,
  );
  if (errors.length > 0) {
    console.error(`Errores (${errors.length}):`);
    for (const err of errors) console.error(' - ' + err);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('contracts:import-excel falló:', err);
  process.exitCode = 1;
});

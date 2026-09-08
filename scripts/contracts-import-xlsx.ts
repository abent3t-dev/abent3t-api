/**
 * Fase §15 (regla 7 de la fase): carga inicial ÚNICA del Excel de Diana/Jorge
 * a la tabla `contracts`. Es un script de una sola vez, NO un endpoint — el
 * Excel queda reemplazado por el sistema, no importado de forma recurrente.
 *
 * GUARD: se niega a correr con NODE_ENV=production. La carga real a prod se
 * decidirá con Ingrid cuando entregue el Excel con las dos columnas nuevas
 * (email_comprador, email_y_nombre_usuario) — ajustar HEADERS si los títulos
 * finales difieren.
 *
 * USO:  npm run contracts:import-excel -- "C:\\ruta\\Excel_Diana_Jorge.xlsx"
 *
 * Reglas:
 *  - El proveedor se busca por razón social EXACTA (case-insensitive) en
 *    `suppliers`; si no existe, la fila se reporta como error (no se inventa).
 *  - `document_type` se normaliza (minúsculas, sin acentos); si no matchea el
 *    enum, la fila se reporta como error.
 *  - Duplicados de contract_number se reportan y se saltan.
 *  - Los PDFs NO se cargan aquí: se suben después desde la UI (§15).
 */
import { readFileSync } from 'fs';
import * as XLSX from 'xlsx';
import { PrismaService } from '../src/prisma/prisma.service';

const HEADERS = {
  number: 'Numero',
  tomo: 'Tomo',
  documentType: 'Tipo de documento',
  service: 'Servicio',
  supplier: 'Proveedor',
  startDate: 'Inicio vigencia',
  endDate: 'Fin vigencia',
  buyerEmail: 'Email comprador',
  responsible: 'Usuario responsable', // "email y nombre", ej. "ana@x.com - Ana"
} as const;

const DOCUMENT_TYPES = [
  'contrato',
  'addenda',
  'convenio',
  'carta_compromiso',
  'otro',
] as const;
type DocumentType = (typeof DOCUMENT_TYPES)[number];

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/** Fechas del Excel: llegan como serial numérico o como texto. */
function parseExcelDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
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

function cellText(row: Record<string, unknown>, header: string): string {
  const value = row[header];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Guard de seguridad: este script de carga inicial no corre con NODE_ENV=production (regla 7 de la fase §15)',
    );
  }
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error(
      'Falta la ruta del Excel. Uso: npm run contracts:import-excel -- <ruta.xlsx>',
    );
  }

  const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: undefined,
    blankrows: false,
    raw: true,
  });

  const prisma = new PrismaService();
  await prisma.$connect();
  let success = 0;
  const errors: string[] = [];
  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // 1 = encabezados
      const number = cellText(row, HEADERS.number);
      const supplierName = cellText(row, HEADERS.supplier);
      const service = cellText(row, HEADERS.service);
      const rawType = cellText(row, HEADERS.documentType);
      const startDate = parseExcelDate(row[HEADERS.startDate]);
      const endDate = parseExcelDate(row[HEADERS.endDate]);

      if (!number || !supplierName || !service || !startDate || !endDate) {
        errors.push(
          `Fila ${rowNumber}: faltan datos obligatorios (numero/proveedor/servicio/vigencia)`,
        );
        continue;
      }
      const documentType = normalize(rawType) as DocumentType;
      if (!DOCUMENT_TYPES.includes(documentType)) {
        errors.push(
          `Fila ${rowNumber} (${number}): tipo de documento desconocido "${rawType}"`,
        );
        continue;
      }
      const supplier = await prisma.suppliers.findFirst({
        where: {
          legal_name: { equals: supplierName, mode: 'insensitive' },
          is_active: true,
        },
        select: { id: true },
      });
      if (!supplier) {
        errors.push(
          `Fila ${rowNumber} (${number}): proveedor "${supplierName}" no existe en el catálogo — darlo de alta primero`,
        );
        continue;
      }

      const buyerEmail = cellText(row, HEADERS.buyerEmail);
      const buyer = buyerEmail
        ? await prisma.profiles.findFirst({
            where: { email: { equals: buyerEmail, mode: 'insensitive' } },
            select: { id: true },
          })
        : null;
      if (buyerEmail && !buyer) {
        errors.push(
          `Fila ${rowNumber} (${number}): comprador "${buyerEmail}" sin perfil — se importa sin comprador asignado`,
        );
      }

      // "email y nombre" en una sola celda: el email es el primer token con @
      const responsibleRaw = cellText(row, HEADERS.responsible);
      const responsibleEmail =
        responsibleRaw.split(/[\s,;-]+/).find((t) => t.includes('@')) ?? null;
      const responsibleName = responsibleEmail
        ? responsibleRaw
            .replace(responsibleEmail, '')
            .replace(/^[\s,;-]+|[\s,;-]+$/g, '') || null
        : responsibleRaw || null;

      try {
        await prisma.contracts.create({
          data: {
            contract_number: number,
            tomo: cellText(row, HEADERS.tomo) || null,
            document_type: documentType,
            service_description: service,
            supplier_id: supplier.id,
            start_date: startDate,
            end_date: endDate,
            buyer_profile_id: buyer?.id ?? null,
            responsible_user_email: responsibleEmail,
            responsible_user_name: responsibleName,
            notes: 'Importado del Excel histórico (Diana/Jorge)',
          },
        });
        success += 1;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === 'P2002') {
          errors.push(
            `Fila ${rowNumber}: contrato ${number} ya existe — saltado`,
          );
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Fila ${rowNumber} (${number}): ${msg.slice(0, 150)}`);
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`Importación §15: ${success}/${rows.length} contratos creados`);
  if (errors.length > 0) {
    console.error(`Errores (${errors.length}):`);
    for (const err of errors) console.error(` - ${err}`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('contracts:import-excel falló:', err);
  process.exitCode = 1;
});

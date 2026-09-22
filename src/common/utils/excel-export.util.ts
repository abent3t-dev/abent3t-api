import * as ExcelJS from 'exceljs';
import type { Response } from 'express';

/**
 * Sprint 2026-09-22 (B1) — Export a Excel de listados de Compras.
 *
 * Un solo generador para todas las tablas: columnas declaradas por el
 * caller (mismas que la tabla visible), filas ya normalizadas (montos como
 * number, fechas como Date/ISO). Solo GET; nunca incluye `raw`.
 *
 * "No disponible" viaja como texto para no inventar ceros (regla T10).
 */

export interface ExcelColumn<T> {
  header: string;
  /** Extrae el valor de la fila; null/undefined → celda vacía. */
  value: (row: T) => unknown;
  width?: number;
  /** 'money' aplica formato numérico con 2 decimales; 'date' dd/mm/yyyy. */
  kind?: 'text' | 'money' | 'date' | 'int';
}

export const NO_DISPONIBLE = 'No disponible';

const A3T_GREEN = 'FF52AF32';

/** Texto seguro de un valor desconocido (nunca "[object Object]"). */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function toCell(value: unknown, kind: ExcelColumn<unknown>['kind']): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (kind === 'date') {
    const date = value instanceof Date ? value : new Date(asText(value));
    return Number.isNaN(date.getTime()) ? asText(value) : date;
  }
  if (kind === 'money' || kind === 'int') {
    const n = typeof value === 'number' ? value : Number(asText(value));
    return Number.isFinite(n) ? n : asText(value);
  }
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    value instanceof Date
  )
    return value;
  return asText(value);
}

export async function buildExcel<T>(
  sheetName: string,
  columns: ExcelColumn<T>[],
  rows: T[],
  options: { truncated?: boolean; note?: string } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'ABENT 3T';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(sheetName.slice(0, 31), {
    views: [{ state: 'frozen', xSplit: 0, ySplit: 1 }],
  });
  sheet.columns = columns.map((c, i) => ({
    header: c.header,
    key: `c${i}`,
    width: c.width ?? 18,
  }));
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: A3T_GREEN },
  };
  headerRow.alignment = { vertical: 'middle' };

  for (const row of rows) {
    const values: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      values[`c${i}`] = toCell(c.value(row), c.kind);
    });
    sheet.addRow(values);
  }
  columns.forEach((c, i) => {
    const col = sheet.getColumn(`c${i}`);
    if (c.kind === 'money') col.numFmt = '#,##0.00';
    else if (c.kind === 'int') col.numFmt = '0';
    else if (c.kind === 'date') col.numFmt = 'dd/mm/yyyy';
  });
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  if (options.truncated || options.note) {
    const notes = workbook.addWorksheet('Nota');
    if (options.truncated) {
      notes.addRow([
        'El listado excede el tope de filas del export; se incluyen las primeras. Acota con los filtros para exportar el resto.',
      ]);
    }
    if (options.note) notes.addRow([options.note]);
  }

  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** Nombre de archivo con fecha: `<base>_2026-09-22.xlsx`. */
export function excelFilename(base: string, date = new Date()): string {
  return `${base}_${date.toISOString().slice(0, 10)}.xlsx`;
}

/** Cabeceras + envío del binario (patrón de budgets export-template). */
export function sendExcel(res: Response, buffer: Buffer, filename: string) {
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

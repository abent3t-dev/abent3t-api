/**
 * Sprint 2026-09-22 (B1) — generador de Excel compartido por los exports.
 * Se verifica el contenido real del libro (ExcelJS lee el buffer): columnas
 * = encabezados declarados, tipos por columna, "No disponible" como texto y
 * la hoja de nota cuando el listado se truncó.
 */
import * as ExcelJS from 'exceljs';
import { buildExcel, excelFilename, NO_DISPONIBLE } from './excel-export.util';

interface Row {
  num: number;
  name: string | null;
  amount: number | null;
  date: Date | null;
}

const COLUMNS = [
  { header: 'Número', value: (r: Row) => r.num, kind: 'int' as const },
  { header: 'Nombre', value: (r: Row) => r.name },
  {
    header: 'Monto',
    value: (r: Row) => r.amount ?? NO_DISPONIBLE,
    kind: 'money' as const,
  },
  { header: 'Fecha', value: (r: Row) => r.date, kind: 'date' as const },
];

async function read(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return wb;
}

describe('buildExcel', () => {
  it('escribe encabezados, filas y "No disponible" sin inventar ceros', async () => {
    const buffer = await buildExcel('Prueba', COLUMNS, [
      {
        num: 1,
        name: 'A',
        amount: 10.5,
        date: new Date('2026-09-22T00:00:00Z'),
      },
      { num: 2, name: null, amount: null, date: null },
    ]);
    const wb = await read(buffer);
    const sheet = wb.getWorksheet('Prueba');
    expect(sheet).toBeDefined();
    expect(sheet!.getRow(1).values).toEqual([
      undefined,
      'Número',
      'Nombre',
      'Monto',
      'Fecha',
    ]);
    expect(sheet!.getRow(2).getCell(1).value).toBe(1);
    expect(sheet!.getRow(2).getCell(3).value).toBe(10.5);
    expect(sheet!.getRow(2).getCell(4).value).toBeInstanceOf(Date);
    // Fila sin datos: celda vacía (no 0) y el texto "No disponible" tal cual
    expect(sheet!.getRow(3).getCell(2).value).toBeNull();
    expect(sheet!.getRow(3).getCell(3).value).toBe(NO_DISPONIBLE);
    expect(sheet!.getRow(3).getCell(4).value).toBeNull();
    expect(sheet!.getColumn(3).numFmt).toBe('#,##0.00');
    expect(wb.getWorksheet('Nota')).toBeUndefined();
  });

  it('agrega la hoja "Nota" cuando el listado se truncó por el tope', async () => {
    const buffer = await buildExcel('Prueba', COLUMNS, [], { truncated: true });
    const wb = await read(buffer);
    const note = wb.getWorksheet('Nota');
    expect(note).toBeDefined();
    expect(note!.getRow(1).getCell(1).value as string).toContain('tope');
  });

  it('nombra el archivo con la fecha', () => {
    expect(excelFilename('ordenes_sap', new Date('2026-09-22T15:00:00Z'))).toBe(
      'ordenes_sap_2026-09-22.xlsx',
    );
  });
});

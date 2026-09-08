import {
  MaximoContractLine,
  MaximoContractStatusEntry,
} from './maximo-records.types';

/**
 * Fase INT-5 — Derivación de líneas e historial desde el `raw` JSONB de
 * `maximo_contracts`, con las dos formas reales que persiste el sync (Int-3):
 *
 *  1. Registro PR con `PURCHVIEW` anidado (legacy compacto): la revisión se
 *     localiza por (CONTRACTNUM, REVISIONNUM) dentro del arreglo.
 *  2. Registro de contrato directo en la raíz (CONTRACTNUM/CONTRACTLINE/
 *     CONTRACTSTATUS al primer nivel).
 *
 * Todo es mejor-esfuerzo sobre datos externos: campo ausente o con forma
 * inesperada → null / lista vacía, nunca una excepción (el raw es de Maximo,
 * no nuestro).
 */

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecordArray(value: unknown): RawRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Localiza el registro de contrato de UNA revisión dentro del raw. */
export function findContractRecord(
  raw: unknown,
  contractnum: string | null,
  revisionnum: number | null,
): RawRecord | null {
  if (!isRecord(raw)) return null;
  const purchview = asRecordArray(raw.PURCHVIEW);
  if (purchview.length === 1) return purchview[0];
  if (purchview.length > 1) {
    return (
      purchview.find(
        (pv) =>
          asString(pv.CONTRACTNUM) === contractnum &&
          asNumber(pv.REVISIONNUM) === revisionnum,
      ) ?? null
    );
  }
  // Forma 2: el raw ES el registro de contrato.
  if (raw.CONTRACTNUM !== undefined) return raw;
  return null;
}

export function deriveContractLines(
  raw: unknown,
  contractnum: string | null,
  revisionnum: number | null,
): MaximoContractLine[] {
  const record = findContractRecord(raw, contractnum, revisionnum);
  if (!record) return [];
  return asRecordArray(record.CONTRACTLINE).map((line) => ({
    lineNum: asNumber(line.CONTRACTLINENUM),
    itemNum: asString(line.ITEMNUM),
    description: asString(line.DESCRIPTION),
    quantity: asNumber(line.ORDERQTY),
    unitCost: asNumber(line.UNITCOST),
  }));
}

export function deriveContractStatusHistory(
  raw: unknown,
  contractnum: string | null,
  revisionnum: number | null,
): MaximoContractStatusEntry[] {
  const record = findContractRecord(raw, contractnum, revisionnum);
  if (!record) return [];
  return asRecordArray(record.CONTRACTSTATUS)
    .map((entry) => ({
      status: asString(entry.STATUS),
      changedAt: asString(entry.CHANGEDATE),
    }))
    .sort((a, b) => (a.changedAt ?? '').localeCompare(b.changedAt ?? ''));
}

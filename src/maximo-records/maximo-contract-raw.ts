import { canonicalize } from '../common/maximo/maximo-canonical';
import type { CanonicalMaximoRecord } from '../common/maximo/maximo-canonical';
import {
  MaximoContractLine,
  MaximoContractStatusEntry,
} from './maximo-records.types';

/**
 * Fase INT-5 — Derivación de líneas e historial desde el `raw` JSONB de
 * `maximo_contracts`, con las dos formas de registro que persiste el sync
 * (Int-3):
 *
 *  1. Registro PR con `PURCHVIEW` anidado: la revisión se localiza por
 *     (CONTRACTNUM, REVISIONNUM) dentro del arreglo.
 *  2. Registro de contrato directo en la raíz (CONTRACTNUM/CONTRACTLINE/
 *     CONTRACTSTATUS al primer nivel).
 *
 * K3.7 (2026-10-05): el raw se canoniza ANTES de buscar (`canonicalize`, de
 * common/maximo, sin depender de la capa de integración). El `raw` de prod
 * es legacy ANIDADO (`Attributes`/`RelatedMbos`): sin canonizar, el detalle
 * de contrato salía sin líneas ni historial. También acepta el compacto y
 * el OSLC.
 *
 * Todo es mejor-esfuerzo sobre datos externos: campo ausente o con forma
 * inesperada → null / lista vacía, nunca una excepción (el raw es de Maximo,
 * no nuestro).
 */

export function asRecordArray(value: unknown): CanonicalMaximoRecord[] {
  return Array.isArray(value)
    ? value.filter(
        (v): v is CanonicalMaximoRecord =>
          typeof v === 'object' && v !== null && !Array.isArray(v),
      )
    : [];
}

export function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return null;
}

export function asNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Localiza el registro de contrato de UNA revisión dentro del raw (ya
 * canonizado: claves en mayúsculas, escalares desenvueltos).
 */
export function findContractRecord(
  raw: unknown,
  contractnum: string | null,
  revisionnum: number | null,
): CanonicalMaximoRecord | null {
  const record = canonicalize(raw);
  if (!record) return null;
  const purchview = asRecordArray(record.PURCHVIEW);
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
  if (record.CONTRACTNUM !== undefined) return record;
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

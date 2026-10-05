import { canonicalize } from '../common/maximo/maximo-canonical';
import type { CanonicalMaximoRecord } from '../common/maximo/maximo-canonical';
import { asNumber, asRecordArray, asString } from './maximo-contract-raw';
import type { MaximoPurchaseOrderLine } from './maximo-records.types';

/**
 * K7.1 (2026-10-05) — Líneas de la OC (POLINE) para el detalle, desde el
 * `raw` de `maximo_purchase_orders` ya canonizado (`canonicalize`, de
 * common/maximo: este módulo no depende de la capa de integración). El raw
 * de prod es legacy ANIDADO (`Attributes`/`RelatedMbos`); también acepta el
 * compacto y el OSLC.
 *
 * Mismos campos que lee el mapper de la integración (POLINENUM, ITEMNUM,
 * RECEIVEDQTY, LINECOST, RECEIPTSCOMPLETE). Sin cantidad pedida: ORDERQTY no
 * llega en AB_COMPRAS. Mejor esfuerzo, como el raw de contratos: campo
 * ausente o con forma inesperada → null / lista vacía, nunca una excepción.
 */

/** Bandera de Maximo ("1"/"0", true/false, "Y"/"N"); null si no viene. */
function asFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const text = asString(value)?.trim() ?? '';
  if (text === '') return null;
  return ['1', 'TRUE', 'Y', 'YES'].includes(text.toUpperCase());
}

function firstChild(
  record: CanonicalMaximoRecord,
  key: string,
): CanonicalMaximoRecord | null {
  return asRecordArray(record[key])[0] ?? null;
}

function lineOf(line: CanonicalMaximoRecord): MaximoPurchaseOrderLine {
  const item = firstChild(line, 'ITEM');
  return {
    line_num: asNumber(line.POLINENUM),
    item_num: asString(line.ITEMNUM) ?? asString(item?.ITEMNUM),
    // la de la línea (la que trae la OC); si no viene, la del artículo
    description: asString(line.DESCRIPTION) ?? asString(item?.DESCRIPTION),
    received_qty: asNumber(line.RECEIVEDQTY),
    line_cost: asNumber(line.LINECOST),
    receipts_complete: asFlag(line.RECEIPTSCOMPLETE),
  };
}

/**
 * Líneas por POLINENUM ascendente, sin número al final (Maximo no garantiza
 * el orden de POLINE). El sort es estable: dos líneas sin número conservan
 * el orden de llegada.
 */
export function derivePurchaseOrderLines(
  raw: unknown,
): MaximoPurchaseOrderLine[] {
  const record = canonicalize(raw);
  if (!record) return [];
  return asRecordArray(record.POLINE)
    .map(lineOf)
    .sort((a, b) => {
      if (a.line_num === b.line_num) return 0;
      if (a.line_num === null) return 1;
      if (b.line_num === null) return -1;
      return a.line_num - b.line_num;
    });
}

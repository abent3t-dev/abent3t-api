import type { ColumnDefs } from '../common/column-filters/column-filters';
import type { MaximoContractView } from './maximo-records.types';

/**
 * Pedidos de Ingrid 2026-09-25 (E2, parte independiente de la decisión del
 * consumido) — "Agrupar por contrato": AB_CONTRATOS entrega una fila por
 * solicitud (PR) que usa el contrato, así que el mismo contrato se repetía
 * (el 1051 salía 8 veces con el mismo valor). Aquí se arma UNA fila por
 * `contractnum` con su revisión más alta y la lista de sus PR; los conteos y
 * montos se toman una sola vez por contrato.
 */

export interface MaximoContractGroupPr {
  prnum: string | null;
  status: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  created_at_source: Date | null;
  approved_at: Date | null;
}

export interface MaximoContractGroupView {
  contractnum: string;
  /** Clave para abrir el detalle (la PR de la fila representativa). */
  detail_key: string;
  revisionnum: number | null;
  status: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  currency: string | null;
  contract_value: number | null;
  consumed_value: number | null;
  balance_value: number | null;
  maxvol: number | null;
  start_date: Date | null;
  end_date: Date | null;
  department: string | null;
  pr_count: number;
  prs: MaximoContractGroupPr[];
}

const time = (d: Date | null) => (d ? new Date(d).getTime() : -Infinity);

/**
 * Representante del contrato: la fila con la revisión de contrato más alta
 * (empate → la que cambió más recientemente en el staging).
 */
function isNewer(a: MaximoContractView, b: MaximoContractView): boolean {
  const ra = a.revisionnum ?? -1;
  const rb = b.revisionnum ?? -1;
  if (ra !== rb) return ra > rb;
  return (
    time(a.last_changed_at ?? a.last_seen_at) >
    time(b.last_changed_at ?? b.last_seen_at)
  );
}

/** Agrupa las filas con contrato; las PR sin contrato no entran. */
export function groupContracts(
  rows: MaximoContractView[],
): MaximoContractGroupView[] {
  const groups = new Map<
    string,
    { rep: MaximoContractView; rows: MaximoContractView[] }
  >();
  for (const row of rows) {
    const key = row.contractnum?.trim();
    if (!row.has_contract || !key) continue;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { rep: row, rows: [row] });
      continue;
    }
    group.rows.push(row);
    if (isNewer(row, group.rep)) group.rep = row;
  }
  return [...groups.entries()]
    .map(([contractnum, { rep, rows: members }]) => ({
      contractnum,
      detail_key: rep.prnum ?? contractnum,
      revisionnum: rep.revisionnum,
      status: rep.status,
      vendor_id: rep.vendor_id,
      vendor_name: rep.vendor_name,
      currency: rep.currency,
      contract_value: rep.contract_value,
      consumed_value: rep.consumed_value,
      balance_value: rep.balance_value,
      maxvol: rep.maxvol,
      start_date: rep.start_date,
      end_date: rep.end_date,
      department: rep.department,
      pr_count: members.filter((m) => m.prnum !== null).length,
      prs: members
        .filter((m) => m.prnum !== null)
        .map((m) => ({
          prnum: m.prnum,
          status: m.status,
          requested_by: m.requested_by,
          requested_by_name: m.requested_by_name,
          created_at_source: m.created_at_source,
          approved_at: m.approved_at,
        }))
        .sort((a, b) => time(b.created_at_source) - time(a.created_at_source)),
    }))
    .sort(
      (a, b) =>
        time(b.end_date) - time(a.end_date) ||
        a.contractnum.localeCompare(b.contractnum, 'es', { numeric: true }),
    );
}

/** Columnas filtrables de la vista agrupada (mismas claves que la plana). */
export const MAXIMO_CONTRACT_GROUP_FILTER_COLUMNS: ColumnDefs<MaximoContractGroupView> =
  {
    contrato: { type: 'text', value: (r) => r.contractnum },
    solicitudes: { type: 'number', value: (r) => r.pr_count },
    estatus: { type: 'text', value: (r) => r.status },
    proveedor: { type: 'text', value: (r) => r.vendor_name },
    valor: { type: 'number', value: (r) => r.contract_value },
    consumido: { type: 'number', value: (r) => r.consumed_value },
    saldo: { type: 'number', value: (r) => r.balance_value },
    moneda: { type: 'text', value: (r) => r.currency },
    inicio: { type: 'date', value: (r) => r.start_date },
    fin: { type: 'date', value: (r) => r.end_date },
    depto: { type: 'text', value: (r) => r.department },
    revision: { type: 'number', value: (r) => r.revisionnum },
  };

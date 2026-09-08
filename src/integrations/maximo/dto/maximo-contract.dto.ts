import {
  MAXIMO_ERP,
  MaximoPersonDto,
  MaximoStatusChangeDto,
  MaximoVendorDto,
} from './maximo-po.dto';

/**
 * DTO interno normalizado de un registro de la OS `AB_CONTRATOS` (raíz PR).
 *
 * Un registro puede traer contrato (PR + PURCHVIEW + COMPANIES + CONTRACTSTATUS
 * + CONTRACTLINE + PERSON) o solo la cabecera PR + PERSON. `hasContract`
 * distingue ambos casos; con `false`, todo lo de contrato es `null`/`[]`.
 *
 * Diccionario (REPORTE_VALIDACION_V2 §3.2):
 *   ERP = 'Maximo' · OPEX/CAPEX = constante 'OPEX' · ÁREA = PERSON.DEPARTMENT
 *   Fecha creación contrato   = CONTRACTSTATUS.CHANGEDATE con STATUS=WAPPR (regla
 *                               pendiente de confirmar; null si no hay WAPPR)
 *   Fecha liberación contrato = CONTRACTSTATUS.CHANGEDATE con STATUS=APPR
 *   Consumo = PURCHVIEW.TOTALCOST · Valor = PURCHVIEW.MAXVOL (hoy no lo expone la OS)
 *
 * Semántica de las fechas derivadas: el match de estatus es LITERAL ('APPR',
 * 'WAPPR') y de PRIMERA ocurrencia, sobre el historial de LA REVISIÓN mapeada.
 * La evidencia v1 muestra sinónimos por nivel (APPR1..APPR4, WSTART, SUSPND)
 * que NO se infieren (misma regla que §20.2): confirmar con Isaac si APPRn
 * cuenta como aprobación — pendiente Int-3. Clave natural sugerida:
 * (prnum, contractNum, revisionNum).
 *
 * ⚠ `PERSON.STATUS` es el estatus de la PERSONA: jamás se mapea a nada del contrato.
 * ⚠ CONTRACTREFNUM / CONTRACTVALUE: pendientes de confirmación de Isaac
 *   (CLAUDE_COMPRAS.md §20.2). Se mapean SOLO si llegan con ese nombre exacto;
 *   NUNCA se rellenan desde MAXVOL ni CONTRACTNUM.
 */

export const MAXIMO_CONTRACT_EXPENSE_TYPE = 'OPEX' as const;

export interface MaximoContractLineDto {
  lineNum: number | null;
  itemNum: string | null;
  /** CONTRACTLINE.DESCRIPTION (estructura actual) o ITEM.DESCRIPTION (previa). */
  description: string | null;
}

export interface MaximoContractDto {
  erp: typeof MAXIMO_ERP;
  expenseType: typeof MAXIMO_CONTRACT_EXPENSE_TYPE;

  /** PR.PRNUM. null solo en la estructura previa (raíz PURCHVIEW). */
  prnum: string | null;
  siteId: string | null;
  requestedBy: string | null;
  /** PERSON.DEPARTMENT. */
  area: string | null;
  requester: MaximoPersonDto | null;

  hasContract: boolean;
  /**
   * Cuántas PURCHVIEW (revisiones) traía el registro crudo. El DTO mapea la
   * de mayor REVISIONNUM; si es > 1, Int-3 debe decidir qué hacer con el resto.
   */
  purchviewCount: number;
  contractNum: string | null;
  /** §20.2 — pendiente de Isaac. Solo si llega `CONTRACTREFNUM` literal. */
  contractRefNum: string | null;
  /** §20.2 — pendiente de Isaac. Solo si llega `CONTRACTVALUE` literal. */
  contractValue: number | null;
  orgId: string | null;
  revisionNum: number | null;
  currencyCode: string | null;
  startDate: string | null;
  endDate: string | null;
  /** PURCHVIEW.MAXVOL (valor máximo); la OS actual no lo expone → null. */
  maxVol: number | null;
  /** PURCHVIEW.TOTALCOST → consumo del contrato. */
  totalCost: number | null;

  /** Último CONTRACTSTATUS por CHANGEDATE (desempate por id). NUNCA PERSON.STATUS. */
  status: string | null;
  statusHistory: MaximoStatusChangeDto[];
  /** Regla WAPPR: primera CONTRACTSTATUS con STATUS=WAPPR literal; null si no aparece. */
  createdDate: string | null;
  /** 'WAPPR' cuando `createdDate` se derivó con esa regla; null si no aplicó. */
  createdDateRule: 'WAPPR' | null;
  /** Primera CONTRACTSTATUS con STATUS=APPR literal (APPR1..4 no cuentan, ver arriba). */
  approvedDate: string | null;

  vendor: MaximoVendorDto | null;
  lines: MaximoContractLineDto[];
  /** rowstamp de la RAÍZ del registro (PR en la estructura actual). */
  rowstamp: string | null;
  /**
   * rowstamp de la PURCHVIEW mapeada — es la fila que muta con estatus,
   * consumo y líneas; para detectar cambios en Int-3 usar ESTE, no `rowstamp`.
   */
  contractRowstamp: string | null;
}

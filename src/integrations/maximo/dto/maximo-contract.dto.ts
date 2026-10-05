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
 *   PR (raíz, K3)             = STATUS, STATUSDATE, ISSUEDATE, TOTALCOST y el
 *                               historial PRSTATUS[]; se repiten en cada revisión
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

/**
 * K3 (2026-10-05): un cambio del historial PRSTATUS de la PR. Mismo orden que
 * los historiales de OC y contrato (CHANGEDATE ascendente, desempate por
 * PRSTATUSID), más la nota del cambio. `MaximoStatusChangeDto` (compartido
 * por OC y contrato) no cambia.
 */
export interface MaximoPrStatusChangeDto extends MaximoStatusChangeDto {
  /** PRSTATUS.MEMO (p. ej. motivo de la cancelación); null si no viene. */
  memo: string | null;
}

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
  /**
   * Bloque 2026-09-23 (D8): consumido del contrato — primera llave numérica
   * presente en PURCHVIEW entre RELEASEDTOTAL / RELEASEDCOST / TOTALRELEASED /
   * COMMITTED / COMMITTEDTOTAL / INVOICEDTOTAL / TOTALINVOICED. La OS actual
   * no expone ninguna → null ("No disponible"); cuando CIISA la exponga, el
   * siguiente sync la pinta (K8: otro hash → 'remapped'). saldo =
   * contractValue − consumedValue.
   */
  consumedValue: number | null;
  /**
   * Bloque 2026-09-23 (D7): monto de la PR = PR.TOTALCOST de la raíz (llega
   * en todas desde el 2-oct); respaldo PR.PRCOST o suma de PRLINE.LINECOST.
   * Base de impuestos desconocida: se rotula "monto de la PR (Maximo)" y no se
   * combina con las solicitudes de SAP. null = no viene ("No disponible").
   */
  prTotal: number | null;
  /**
   * D2 / K3 (2026-10-05): PR.STATUS de la raíz (WAPPR, APPR, CLOSE, CAN).
   * PRSTATUS ya no es respaldo: es el hijo historial (`prStatusHistory`).
   * `status` lo usa en las filas sin contrato. Nunca PERSON.STATUS.
   */
  prStatus: string | null;
  /** K3: PR.ISSUEDATE (creación de la PR). */
  prIssueDate: string | null;
  /** K3: PR.STATUSDATE (desde cuándo tiene su estatus actual). */
  prStatusDate: string | null;
  /** K3: historial PRSTATUS ordenado (CHANGEDATE, desempate por PRSTATUSID). */
  prStatusHistory: MaximoPrStatusChangeDto[];
  /**
   * K3: CHANGEDATE de la PRIMERA PRSTATUS=APPR = llegada a Compras (no se
   * mueve si regresa a WAPPR y se re-aprueba). null = sin APPR en el
   * historial; no se infiere.
   */
  prApprovedDate: string | null;
  /** K3: CHANGEBY de esa primera APPR (quién aprobó). */
  prApprovedBy: string | null;
  /** K3: CHANGEDATE de la ÚLTIMA PRSTATUS=CLOSE. */
  prClosedDate: string | null;
  /**
   * K3: CHANGEDATE de la ÚLTIMA PRSTATUS=CAN del historial. null si no hay
   * fila CAN, aunque STATUS sea CAN (sin respaldo por STATUSDATE).
   */
  prCancelledDate: string | null;
  /** K3: CHANGEBY de esa CAN (quién canceló). */
  prCancelledBy: string | null;

  /**
   * Último CONTRACTSTATUS por CHANGEDATE (desempate por id); en una fila SIN
   * contrato, el estatus de la PR (`prStatus`). NUNCA PERSON.STATUS.
   */
  status: string | null;
  statusHistory: MaximoStatusChangeDto[];
  /** Regla WAPPR: primera CONTRACTSTATUS con STATUS=WAPPR literal; null si no aparece. */
  createdDate: string | null;
  /** 'WAPPR' cuando `createdDate` se derivó con esa regla; null si no aplicó. */
  createdDateRule: 'WAPPR' | null;
  /** Primera CONTRACTSTATUS con STATUS=APPR literal (APPR1..4 no cuentan, ver arriba). */
  approvedDate: string | null;
  /** CHANGEBY del primer CONTRACTSTATUS=APPR (quién aprobó); null si nunca. */
  approvedBy: string | null;

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

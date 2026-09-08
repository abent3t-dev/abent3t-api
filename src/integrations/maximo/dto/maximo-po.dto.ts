/**
 * DTO interno normalizado de una Orden de Compra de Maximo (OS `AB_COMPRAS`).
 *
 * Diccionario de mapeo (CLAUDE_COMPRAS.md §Máximo, REPORTE_VALIDACION_V2 §2.1):
 *   ERP                  = constante 'Maximo'
 *   ÁREA                 = PERSON.DEPARTMENT
 *   OPEX/CAPEX           = PO.AB_CLASFPO (nullable: población incremental)
 *   Fecha creación PO    = PO.ORDERDATE
 *   Fecha liberación PO  = POSTATUS.CHANGEDATE con STATUS=APPR (primera aprobación)
 *   Tipo de compra       = PO.AB_TIPOCOMP   · Ahorro = PO.AB_AHORRO
 *   Solicitante / PR     = POLINE→PRLINE→PR (REQUESTEDBY, ISSUEDATE, STATUSDATE)
 *   Proveedor            = COMPANIES.NAME   · Comprador = PERSON.DISPLAYNAME
 *
 * Todo campo que Maximo pueda omitir es `null` explícito (nunca `undefined`).
 */

export const MAXIMO_ERP = 'Maximo' as const;

export interface MaximoStatusChangeDto {
  status: string;
  /** ISO 8601 tal como lo entrega Maximo (`…+00:00`). */
  changeDate: string | null;
  changedBy: string | null;
}

export interface MaximoVendorDto {
  /** COMPANIES.COMPANY (id de proveedor en Maximo). */
  company: string | null;
  name: string | null;
  orgId: string | null;
}

/** Persona asociada (comprador en PO, solicitante en PR). Solo campos de negocio. */
export interface MaximoPersonDto {
  personId: string | null;
  displayName: string | null;
  /** PERSON.DEPARTMENT → ÁREA del diccionario. */
  department: string | null;
}

export interface MaximoPurchaseRequestRefDto {
  prnum: string | null;
  requestedBy: string | null;
  /** PR.ISSUEDATE → fecha creación PR/SOLPED. */
  issueDate: string | null;
  /** PR.STATUSDATE → fecha liberación PR/SOLPED. */
  statusDate: string | null;
}

export interface MaximoPurchaseOrderLineDto {
  lineNum: number | null;
  itemNum: string | null;
  /** ITEM.DESCRIPTION (`"~null~"` → null). */
  itemDescription: string | null;
  /** POLINE.ENTERDATE → fecha de entrada OC. */
  enterDate: string | null;
  prnum: string | null;
  pr: MaximoPurchaseRequestRefDto | null;
}

export interface MaximoPurchaseOrderDto {
  erp: typeof MAXIMO_ERP;
  ponum: string;
  siteId: string | null;
  revisionNum: number | null;
  /** PO.STATUS a nivel raíz (corregido por CIISA, validado 13 ago 2026). */
  status: string | null;
  description: string | null;

  orderDate: string | null;
  /**
   * Primera POSTATUS con STATUS=APPR LITERAL (primera aprobación de ESTA
   * revisión; con re-aprobaciones REVISD→APPR se conserva la primera). null si
   * el PO nunca fue aprobado. Sinónimos por nivel (APPR1..APPR4, evidencia v1
   * de contratos) NO se infieren — pendiente confirmar con Isaac (Int-3).
   */
  approvedDate: string | null;
  /** Primera POSTATUS con STATUS=WAPPR (se registra por separado, sin derivar nada). */
  waitingApprovalDate: string | null;
  /** Historial completo ordenado por CHANGEDATE ascendente (desempate por POSTATUSID). */
  statusHistory: MaximoStatusChangeDto[];

  vendorDeliveryDate: string | null;
  currencyCode: string | null;
  /** PO.PRETAXTOTAL → valor sin IVA. */
  pretaxTotal: number | null;
  /** PO.TOTALCOST → valor con IVA. */
  totalCost: number | null;

  abAhorro: number | null;
  abTipoComp: string | null;
  /** 'CAPEX' | 'OPEX' | otro valor de Maximo; nullable (población incremental). */
  abClasfPo: string | null;
  purchaseAgent: string | null;

  /** PERSON.DEPARTMENT. */
  area: string | null;
  buyer: MaximoPersonDto | null;
  vendor: MaximoVendorDto | null;

  /** Derivados de la primera línea con PR (conveniencia para reportes). */
  prnum: string | null;
  requestedBy: string | null;
  prIssueDate: string | null;
  prStatusDate: string | null;

  lines: MaximoPurchaseOrderLineDto[];
  rowstamp: string | null;
}

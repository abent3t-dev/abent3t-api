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
 *   Integración con SAP  = PO.PO5 (literal) · Subtotal sin IVA = Σ POLINE.LINECOST
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
  /** I1b: POLINE.RECEIPTSCOMPLETE (null = no llega en la Object Structure). */
  receiptsComplete: boolean | null;
  /** I1b: POLINE.RECEIVEDQTY. */
  receivedQty: number | null;
  /**
   * K6 (2026-10-05): POLINE.LINECOST, importe de la línea antes de impuestos
   * en la moneda de la OC (pendiente que CIISA lo confirme). null = no viene.
   */
  lineCost: number | null;
}

/**
 * O3 (2026-10-26): comprador de la solicitud de cotización (RQ) de la OC.
 * CIISA manda en AB_COMPRAS un RFQSTATUS por OC con RQ, ya elegido (el
 * cambio de estatus que hizo el comprador, sin estatus ni fecha).
 */
export interface MaximoRfqBuyerDto {
  /** RFQSTATUS.RFQNUM: liga la OC con su RQ. */
  rfqNum: string | null;
  /** RFQSTATUS.CHANGEBY: usuario de Maximo del comprador. */
  changedBy: string;
  /** PERSON.DISPLAYNAME de esa fila (si su PERSONID es otro, null). */
  displayName: string | null;
  /** RFQSTATUS.RFQSTATUSSEQ: con varias filas, gana la más alta. */
  seq: number | null;
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
   * el PO nunca fue aprobado. APPRn / APPRnREV no cuentan: son la
   * autorización del nivel n y la OC sigue en aprobación hasta APPR (L3,
   * tabla del cliente, 2026-10-07).
   */
  approvedDate: string | null;
  /** CHANGEBY del primer POSTATUS=APPR (usuario Maximo que aprobó); null si nunca. */
  approvedBy: string | null;
  /** Primera POSTATUS con STATUS=WAPPR (se registra por separado, sin derivar nada). */
  waitingApprovalDate: string | null;
  /**
   * F1 (2026-09-25): CHANGEBY del PRIMER estatus del historial (quien creó
   * la OC y la mandó a aprobación). Respaldo del comprador cuando no hay
   * PURCHASEAGENT; se muestra como "Capturó: …".
   */
  createdBy: string | null;
  /** Historial completo ordenado por CHANGEDATE ascendente (desempate por POSTATUSID). */
  statusHistory: MaximoStatusChangeDto[];

  vendorDeliveryDate: string | null;
  currencyCode: string | null;
  /**
   * PO.PRETAXTOTAL tal como llega. Isaac (CIISA): no es persistente, así que
   * no se guarda ni se usa como monto sin IVA; ese es `subtotal` (K6).
   */
  pretaxTotal: number | null;
  /** PO.TOTALCOST → valor con IVA. */
  totalCost: number | null;
  /**
   * K6 (2026-10-05): sin IVA = suma de POLINE.LINECOST redondeada a 2
   * decimales, en la moneda de la OC. null si no hay líneas o a alguna le
   * falta LINECOST; nunca se estima con PRETAXTOTAL ni con TOTALCOST/1.16.
   */
  subtotal: number | null;
  /**
   * K2 (2026-10-05): estado de integración con SAP = PO.PO5 literal, recortado
   * y en mayúsculas (PROCESADO, ACTUALIZAR, ERROR, AGREGAR…), sin interpretar.
   * null = sin dato.
   */
  integrationStatus: string | null;

  abAhorro: number | null;
  abTipoComp: string | null;
  /** 'CAPEX' | 'OPEX' | otro valor de Maximo; nullable (población incremental). */
  abClasfPo: string | null;
  /** PO.PURCHASEAGENT: usuario de Maximo del comprador. */
  purchaseAgent: string | null;
  /** DISPLAYNAME de la PERSON de la OC cuando es el PURCHASEAGENT (E4). */
  purchaseAgentName: string | null;
  /**
   * O3 (2026-10-26): comprador de la RQ = la fila de RFQSTATUS (de la
   * cabecera o de una línea) con CHANGEBY y el RFQSTATUSSEQ más alto. null =
   * OC sin RQ. La misma regla en SQL: `maximoRqBuyerJoin` (erp-views).
   */
  rfqBuyer: MaximoRfqBuyerDto | null;
  /** O3: RFQNUM distintos de todas las filas de RFQSTATUS, ordenados. */
  rfqNums: string[];
  /**
   * O1 (2026-10-26): PO.EXCHANGERATE tal como llega, CONTRA EL DÓLAR (la
   * moneda base de Maximo): ~0.058 en una OC en pesos, 1 en dólares y ~1.19
   * en euros. null = no viene.
   */
  exchangeRate: number | null;
  /**
   * O1/O3 (2026-10-26): CONTRACTREFNUM de la OC: el de la cabecera o, si no,
   * el de la primera línea que lo traiga. OC de contrato =
   * `contractRefNum !== null`; en SQL, `maximoPoDeContrato` (erp-views).
   */
  contractRefNum: string | null;

  /** PERSON.DEPARTMENT. */
  area: string | null;
  buyer: MaximoPersonDto | null;
  vendor: MaximoVendorDto | null;

  /**
   * Derivados de la primera línea con PR por POLINENUM (conveniencia para
   * reportes; K3: las líneas se ordenan antes de derivarlos).
   */
  prnum: string | null;
  requestedBy: string | null;
  /**
   * G2 (2026-09-28): PR.ISSUEDATE de la solicitud MÁS ANTIGUA de la OC (la
   * gestión empieza ahí; misma regla que SAP D3). null = OC sin solicitud.
   */
  prIssueDate: string | null;
  prStatusDate: string | null;
  /** G3 (2026-09-28): PRNUM distintos de todas las líneas, ordenados. */
  prNums: string[];
  /**
   * I1b (2026-09-30): recepción de la OC — RECEIPTS (NONE / PARTIAL /
   * COMPLETE) o derivada de las líneas. null = sin dato en la cabecera ni en
   * las líneas.
   */
  receiptStatus: string | null;

  /** Líneas ordenadas por POLINENUM ascendente (sin número al final). */
  lines: MaximoPurchaseOrderLineDto[];
  rowstamp: string | null;
}

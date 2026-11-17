import { MAXIMO_ERP, MaximoStatusChangeDto } from './maximo-po.dto';

/**
 * O2 (2026-11-17) — DTO interno de un registro de la OS `AB_COTIZACIONES`
 * (raíz RFQ): la solicitud de cotización (RQ) de Maximo, que es lo que cuenta
 * el reporte de avance de Compras. Visto en prod el 17-nov (Bitácora del
 * HANDOFF): 4,680 RQ, las mismas que la tabla RFQ, sin filtro.
 *
 * Diccionario:
 *   Recibida          = ENTERDATE (creación de la RQ)
 *   Comprador         = ENTERBY ("Introducido por"); REQUESTEDBY es el
 *                       usuario del área ("Solicitado por")
 *   Historial         = RFQSTATUS[] colgado de la CABECERA (en AB_COMPRAS
 *                       cuelga de RFQLINE), completo: STATUS, CHANGEDATE,
 *                       CHANGEBY y RFQSTATUSSEQ
 *   Cerrada/cancelada = el último CLOSE / CANCEL del historial
 *   OC de la RQ       = RFQLINE.PONUM (con POLINENUM y POREVISIONNUM)
 * RFQLINE.LINECOST y UNITCOST vienen en 0: los montos salen de la OC. No trae
 * cotizaciones (RFQVENDOR, QUOTATIONLINE) ni nombres de personas (los nombres
 * salen del directorio de N2). El JSON de Maximo omite los campos vacíos: lo
 * que no viene sale `null`.
 */

/** Un cambio del historial RFQSTATUS (mismo orden que los demás historiales). */
export interface MaximoRfqStatusChangeDto extends MaximoStatusChangeDto {
  /** RFQSTATUS.MEMO (p. ej. el motivo de la cancelación); null si no viene. */
  memo: string | null;
}

/** Una línea de la RQ (RFQLINE). */
export interface MaximoRfqLineDto {
  lineNum: number | null;
  /** OC que salió de la línea; null mientras no hay OC. */
  ponum: string | null;
  poLineNum: number | null;
  poRevisionNum: number | null;
  vendor: string | null;
  itemNum: string | null;
  orderQty: number | null;
  orderUnit: string | null;
}

export interface MaximoRfqDto {
  erp: typeof MAXIMO_ERP;
  rfqnum: string;
  siteId: string | null;
  description: string | null;
  status: string | null;
  statusDate: string | null;
  /** ENTERDATE: creación de la RQ. */
  enterDate: string | null;
  /** ENTERBY: "Introducido por" = el comprador. */
  enterBy: string | null;
  /** REQUESTEDBY: "Solicitado por" = el usuario del área. */
  requestedBy: string | null;
  requiredDate: string | null;
  changeBy: string | null;
  changeDate: string | null;
  /** CHANGEDATE ascendente; desempate RFQSTATUSSEQ (o RFQSTATUSID). */
  statusHistory: MaximoRfqStatusChangeDto[];
  /** Último CLOSE con fecha del historial; null si no hay. */
  closedDate: string | null;
  closedBy: string | null;
  /** Último CANCEL con fecha del historial; null si no hay. */
  cancelledDate: string | null;
  cancelledBy: string | null;
  /** Por RFQLINENUM ascendente (sin número al final). */
  lines: MaximoRfqLineDto[];
  /** PONUM de las líneas, distintos y ordenados. */
  poNums: string[];
  rowstamp: string | null;
}

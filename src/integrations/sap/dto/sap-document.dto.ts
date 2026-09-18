/**
 * DTOs canónicos de la integración SAP (Fase INT-4): lo que el mapper
 * produce y el staging persiste. Fechas como string ISO (crudas de SAP);
 * montos como number.
 *
 * Los 3 UDF de compras vienen NORMALIZADOS: el placeholder del ERP
 * ("SELECCIONAR", vacío o null) se colapsa a `null` = SIN DATO. El valor
 * original siempre queda en el `raw` del staging.
 */

export interface SapDocumentLineDto {
  lineNum: number | null;
  itemCode: string | null;
  itemDescription: string | null;
  lineTotal: number | null;
  currency: string | null;
  /** U_Clas_gts (clasificación de gasto). null = sin capturar en el ERP. */
  clasGts: string | null;
  /** U_Imp_ahorro (importe de ahorro). null = sin capturar; 0 es un valor real. */
  impAhorro: number | null;
  /** U_Proc_Comp (proceso de compra). null = sin capturar en el ERP. */
  procComp: string | null;
}

interface SapDocumentBaseDto {
  docEntry: number;
  docNum: number | null;
  docDate: string | null;
  docDueDate: string | null;
  updateDate: string | null;
  documentStatus: string | null;
  comments: string | null;
  lines: SapDocumentLineDto[];
  /** Total de líneas del documento. */
  linesTotal: number;
  /** Líneas con U_Clas_gts REAL (≠ placeholder). */
  linesClassified: number;
  /** Suma de U_Imp_ahorro reales; null = ninguna línea lo trae (T10). */
  ahorroTotal: number | null;
}

export interface SapPurchaseOrderDto extends SapDocumentBaseDto {
  cardCode: string | null;
  cardName: string | null;
  docTotal: number | null;
  currency: string | null;
}

export interface SapPurchaseRequestDto extends SapDocumentBaseDto {
  requester: string | null;
  requesterName: string | null;
  requiredDate: string | null;
  /** Suma de LineTotal (el SL no permite $select=DocTotal en esta entidad). */
  docTotal: number | null;
  /** Moneda de la primera línea; null si el doc no tiene líneas. */
  currency: string | null;
}

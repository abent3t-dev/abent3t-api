/**
 * Ajustes de Compras 2026-09-23 — mapper SAP 1.2.0: importes en la moneda
 * del documento, saldo disponible de la OC, solicitudes base y UserSign.
 *
 * Caso real que lo motivó (OC 5128, DocEntry 5415): SAP manda DocTotal
 * 421,530.49 en MXN aunque la OC es en USD (DocTotalFc 22,620); antes se
 * guardaba y mostraba "USD 421,530.49".
 */
import type { SapApprovalCatalogs } from './dto/sap-document.dto';
import {
  SAP_LOCAL_CURRENCY,
  toSapApprovalRequest,
  toSapPurchaseOrder,
  toSapPurchaseRequest,
} from './sap.mapper';

const line = (over: Record<string, unknown> = {}) => ({
  LineNum: 0,
  ItemCode: 'FIG000008',
  LineTotal: 363388.35,
  RowTotalFC: 19500,
  GrossTotal: 421530.49,
  GrossTotalFC: 22620,
  Currency: 'USD',
  Quantity: 19500,
  RemainingOpenQuantity: 4500,
  LineStatus: 'bost_Open',
  BaseType: -1,
  BaseEntry: null,
  ...over,
});

const usdPo = (over: Record<string, unknown> = {}) => ({
  DocEntry: 5415,
  DocNum: 5128,
  DocumentStatus: 'bost_Open',
  DocTotal: 421530.49,
  DocTotalFc: 22620,
  DocCurrency: 'USD',
  UserSign: 38,
  DocumentLines: [line()],
  ...over,
});

describe('sap.mapper 1.2.0 — importes en la moneda del documento', () => {
  it('la moneda local es MXN', () => {
    expect(SAP_LOCAL_CURRENCY).toBe('MXN');
  });

  it('OC en USD: docTotal = DocTotalFc, líneas con RowTotalFC/GrossTotalFC', () => {
    const dto = toSapPurchaseOrder(usdPo());
    expect(dto.currency).toBe('USD');
    expect(dto.docTotal).toBe(22620);
    expect(dto.lines[0].lineTotal).toBe(19500);
    expect(dto.lines[0].grossTotal).toBe(22620);
    expect(dto.lines[0].currency).toBe('USD');
  });

  it('OC en USD sin DocTotalFc (raw viejo): docTotal null, nunca el importe en MXN', () => {
    const dto = toSapPurchaseOrder(usdPo({ DocTotalFc: undefined }));
    expect(dto.docTotal).toBeNull();
    expect(dto.openTotal).toBeNull();
  });

  it('OC en MXN: docTotal = DocTotal y líneas con LineTotal', () => {
    const dto = toSapPurchaseOrder(
      usdPo({
        DocCurrency: 'MXN',
        DocTotal: 116,
        DocTotalFc: 0,
        DocumentLines: [
          line({
            LineTotal: 100,
            RowTotalFC: 0,
            GrossTotal: 116,
            GrossTotalFC: 0,
            Currency: 'MXN',
            Quantity: 10,
            RemainingOpenQuantity: 10,
          }),
        ],
      }),
    );
    expect(dto.docTotal).toBe(116);
    expect(dto.lines[0].lineTotal).toBe(100);
    expect(dto.openTotal).toBe(116);
  });

  it('solicitud en MXN con precio en USD: el importe es MXN (no "USD")', () => {
    const dto = toSapPurchaseRequest({
      DocEntry: 1378,
      DocCurrency: 'MXN',
      DocumentLines: [
        line({
          LineTotal: 200684.49,
          RowTotalFC: 0,
          Currency: 'USD',
          Quantity: 1,
        }),
      ],
    });
    expect(dto.currency).toBe('MXN');
    expect(dto.docTotal).toBe(200684.49);
  });

  it('solicitud sincronizada sin DocCurrency: local si todas las líneas traen RowTotalFC = 0', () => {
    const local = toSapPurchaseRequest({
      DocEntry: 1,
      DocumentLines: [line({ LineTotal: 50, RowTotalFC: 0 })],
    });
    expect(local.currency).toBe('MXN');
    expect(local.docTotal).toBe(50);
    const unknown = toSapPurchaseRequest({
      DocEntry: 2,
      DocumentLines: [line({ RowTotalFC: 10 })],
    });
    expect(unknown.currency).toBeNull();
  });

  it('borrador en autorización en USD: docTotal = DocTotalFc', () => {
    const catalogs: SapApprovalCatalogs = {
      drafts: new Map([
        [
          7,
          {
            DocNum: 12,
            DocTotal: 6543032.36,
            DocTotalFc: 328279.26,
            DocCurrency: 'USD',
          },
        ],
      ]),
      users: new Map(),
      stages: new Map(),
      templates: new Map(),
    };
    const dto = toSapApprovalRequest({ Code: 1, DraftEntry: 7 }, catalogs);
    expect(dto.docTotal).toBe(328279.26);
    expect(dto.currency).toBe('USD');
  });
});

describe('sap.mapper 1.2.0 — saldo disponible de la OC', () => {
  it('línea abierta con consumo parcial: total × pendiente / cantidad (OC 5128 → USD 5,220)', () => {
    expect(toSapPurchaseOrder(usdPo()).openTotal).toBe(5220);
  });

  it('proporción sobre el total del documento (respeta descuentos de cabecera)', () => {
    const dto = toSapPurchaseOrder(
      usdPo({
        DocTotalFc: 900, // 10% de descuento de cabecera sobre 1,000 de líneas
        DocumentLines: [
          line({ GrossTotalFC: 600, Quantity: 6, RemainingOpenQuantity: 3 }),
          line({
            LineNum: 1,
            GrossTotalFC: 400,
            Quantity: 4,
            RemainingOpenQuantity: 0,
            LineStatus: 'bost_Close',
          }),
        ],
      }),
    );
    // pendiente 300 de 1,000 de líneas → 30% de 900
    expect(dto.openTotal).toBe(270);
  });

  it('cerrada o cancelada: saldo 0; sin líneas con cantidad: null', () => {
    const closed = toSapPurchaseOrder(
      usdPo({
        DocumentStatus: 'bost_Close',
        DocumentLines: [
          line({ LineStatus: 'bost_Close', RemainingOpenQuantity: 0 }),
        ],
      }),
    );
    expect(closed.openTotal).toBe(0);
    expect(toSapPurchaseOrder(usdPo({ DocumentLines: [] })).openTotal).toBe(
      null,
    );
  });
});

describe('sap.mapper 1.2.0 — solicitante y quién capturó', () => {
  it('solicitudes base = BaseEntry de líneas con BaseType 1470000113 (sin repetir)', () => {
    const dto = toSapPurchaseOrder(
      usdPo({
        DocumentLines: [
          line({ BaseType: 1470000113, BaseEntry: 1378 }),
          line({ LineNum: 1, BaseType: 1470000113, BaseEntry: 1378 }),
          line({ LineNum: 2, BaseType: 1470000113, BaseEntry: 1346 }),
          line({ LineNum: 3, BaseType: 22, BaseEntry: 99 }),
        ],
      }),
    );
    expect(dto.baseRequestEntries).toEqual([1346, 1378]);
  });

  it('OC ligada a Maximo: maximoPonum = NumAtCard con U_POID o con formato PONUM', () => {
    const fromIntegration = toSapPurchaseOrder(
      usdPo({ NumAtCard: 'PO104910', U_POID: '22864' }),
    );
    expect(fromIntegration.maximoPonum).toBe('PO104910');
    // 2024: capturadas a mano en SAP con el PONUM como referencia
    const manualPonum = toSapPurchaseOrder(usdPo({ NumAtCard: 'PO103056' }));
    expect(manualPonum.maximoPonum).toBe('PO103056');
    // otra referencia del proveedor (cotización, factura): no es un PONUM
    const vendorRef = toSapPurchaseOrder(usdPo({ NumAtCard: 'COT-55' }));
    expect(vendorRef.maximoPonum).toBeNull();
  });

  it('UserSign se conserva; el nombre lo pone el sync (catálogo Users)', () => {
    const dto = toSapPurchaseOrder(usdPo());
    expect(dto.userSign).toBe(38);
    expect(dto.createdByName).toBeNull();
  });
});

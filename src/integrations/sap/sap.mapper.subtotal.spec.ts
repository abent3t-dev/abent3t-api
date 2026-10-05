/**
 * Bloque K (2026-10-05), K6 — mapper SAP 1.3.0: subtotal sin IVA de la OC.
 *
 * Misma regla que LINECOST en Maximo: la suma de `lines[].lineTotal` (que ya
 * está en la moneda del documento: LineTotal en MXN, RowTotalFC en USD/EUR)
 * redondeada a 2 decimales, y null si no hay líneas o a alguna le falta el
 * importe. Nunca se estima con DocTotal / 1.16 ni con el importe en MXN de
 * una OC en otra moneda.
 */
import { toSapPurchaseOrder, toSapPurchaseRequest } from './sap.mapper';

const line = (over: Record<string, unknown> = {}) => ({
  LineNum: 0,
  ItemCode: 'ITEM-1',
  LineTotal: 100,
  RowTotalFC: 0,
  GrossTotal: 116,
  GrossTotalFC: 0,
  Quantity: 1,
  RemainingOpenQuantity: 1,
  LineStatus: 'bost_Open',
  ...over,
});

const po = (over: Record<string, unknown> = {}) => ({
  DocEntry: 9100,
  DocNum: 6200,
  DocumentStatus: 'bost_Open',
  DocCurrency: 'MXN',
  DocTotal: 406.58,
  DocTotalFc: 0,
  DocumentLines: [
    line(),
    line({ LineNum: 1, LineTotal: 250.5, GrossTotal: 290.58 }),
  ],
  ...over,
});

describe('sap.mapper 1.3.0 — subtotal sin IVA de la OC (K6)', () => {
  it('OC en MXN: suma de LineTotal; docTotal sigue con IVA', () => {
    const dto = toSapPurchaseOrder(po());
    expect(dto.currency).toBe('MXN');
    expect(dto.subtotal).toBe(350.5);
    expect(dto.docTotal).toBe(406.58);
  });

  it('OC en USD (OC 5128): suma de RowTotalFC, nunca el LineTotal en MXN', () => {
    const dto = toSapPurchaseOrder(
      po({
        DocEntry: 5415,
        DocNum: 5128,
        DocCurrency: 'USD',
        DocTotal: 421530.49,
        DocTotalFc: 22620,
        DocumentLines: [
          line({
            LineTotal: 363388.35, // MXN
            RowTotalFC: 19500, // USD
            GrossTotal: 421530.49,
            GrossTotalFC: 22620,
          }),
        ],
      }),
    );
    expect(dto.currency).toBe('USD');
    expect(dto.subtotal).toBe(19500);
    expect(dto.docTotal).toBe(22620);
  });

  it('OC en EUR: suma de RowTotalFC de todas las líneas', () => {
    const dto = toSapPurchaseOrder(
      po({
        DocCurrency: 'EUR',
        DocTotal: 36250,
        DocTotalFc: 1740.58,
        DocumentLines: [
          line({ LineTotal: 25000, RowTotalFC: 1200.4 }),
          line({ LineNum: 1, LineTotal: 6250, RowTotalFC: 300.1 }),
        ],
      }),
    );
    expect(dto.currency).toBe('EUR');
    expect(dto.subtotal).toBe(1500.5);
  });

  it('una línea sin importe → null (no una suma parcial)', () => {
    const mxn = toSapPurchaseOrder(
      po({
        DocumentLines: [line(), line({ LineNum: 1, LineTotal: null })],
      }),
    );
    expect(mxn.subtotal).toBeNull();
    // En USD falta RowTotalFC: tampoco se cae al LineTotal en MXN
    const usd = toSapPurchaseOrder(
      po({
        DocCurrency: 'USD',
        DocTotalFc: 116,
        DocumentLines: [
          line({ RowTotalFC: 100 }),
          line({ LineNum: 1, LineTotal: 5000, RowTotalFC: undefined }),
        ],
      }),
    );
    expect(usd.subtotal).toBeNull();
    expect(usd.docTotal).toBe(116); // el total con IVA no depende de las líneas
  });

  it('sin líneas → null (nunca 0), también si el raw no trae DocumentLines', () => {
    expect(toSapPurchaseOrder(po({ DocumentLines: [] })).subtotal).toBeNull();
    expect(
      toSapPurchaseOrder(po({ DocumentLines: undefined })).subtotal,
    ).toBeNull();
  });

  it('una línea en 0 es un importe real: cuenta en la suma', () => {
    const dto = toSapPurchaseOrder(
      po({ DocumentLines: [line(), line({ LineNum: 1, LineTotal: 0 })] }),
    );
    expect(dto.subtotal).toBe(100);
  });

  it('redondea la suma a 2 decimales (sin ruido de punto flotante)', () => {
    const ruido = toSapPurchaseOrder(
      po({
        DocumentLines: [
          line({ LineTotal: 100.1 }),
          line({ LineNum: 1, LineTotal: 200.2 }),
          line({ LineNum: 2, LineTotal: 300.3 }),
        ],
      }),
    );
    expect(ruido.subtotal).toBe(600.6); // 600.5999999999999 sin redondear
    const tresDecimales = toSapPurchaseOrder(
      po({
        DocumentLines: [
          line({ LineTotal: 10.004 }),
          line({ LineNum: 1, LineTotal: 10.004 }),
        ],
      }),
    );
    expect(tresDecimales.subtotal).toBe(20.01);
  });

  it('las solicitudes no cambian: su importe suma las líneas que lo traen', () => {
    const pr = toSapPurchaseRequest({
      DocEntry: 300,
      DocCurrency: 'MXN',
      DocumentLines: [line(), line({ LineNum: 1, LineTotal: null })],
    });
    expect(pr.docTotal).toBe(100);
  });
});

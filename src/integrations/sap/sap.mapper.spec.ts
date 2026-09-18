import {
  sapRawHash,
  toSapBusinessPartner,
  toSapPurchaseOrder,
  toSapPurchaseRequest,
} from './sap.mapper';
import { SapMappingError } from './sap.errors';

/**
 * Fase INT-4. Mapper puro — sin red ni Nest. Cubre la normalización de los
 * 3 UDF (placeholder "SELECCIONAR" = sin dato), los agregados de línea
 * (T10: ahorro null ≠ 0) y las particularidades de PurchaseRequests
 * (docTotal sumado de LineTotal).
 */

const line = (over: Record<string, unknown> = {}) => ({
  LineNum: 0,
  ItemCode: 'ITEM-1',
  ItemDescription: 'Empaque',
  LineTotal: 100.5,
  Currency: 'MXN',
  U_Clas_gts: 'SELECCIONAR',
  U_Imp_ahorro: null,
  U_Proc_Comp: 'SELECCIONAR',
  ...over,
});

const poDoc = (over: Record<string, unknown> = {}) => ({
  DocEntry: 9000,
  DocNum: 6121,
  DocDate: '2026-07-01T00:00:00Z',
  DocDueDate: '2026-08-24T00:00:00Z',
  UpdateDate: '2026-07-02T00:00:00Z',
  DocumentStatus: 'bost_Open',
  Comments: '',
  CardCode: 'P0000788',
  CardName: 'PROVEEDOR UNO SA DE CV',
  DocTotal: 1335149.25,
  DocCurrency: 'MXN',
  DocumentLines: [line()],
  ...over,
});

describe('sap.mapper — normalización de UDF (sin dato ≠ valor)', () => {
  it('placeholder "SELECCIONAR" y vacíos colapsan a null; valores reales se conservan', () => {
    const dto = toSapPurchaseOrder(
      poDoc({
        DocumentLines: [
          line(), // placeholders
          line({
            LineNum: 1,
            U_Clas_gts: 'OPEX',
            U_Proc_Comp: 'Licitación',
            U_Imp_ahorro: 27645,
          }),
          line({ LineNum: 2, U_Clas_gts: '  seleccionar  ' }), // case+trim
          line({ LineNum: 3, U_Clas_gts: '' }),
        ],
      }),
    );
    expect(dto.lines[0].clasGts).toBeNull();
    expect(dto.lines[0].procComp).toBeNull();
    expect(dto.lines[0].impAhorro).toBeNull();
    expect(dto.lines[1].clasGts).toBe('OPEX');
    expect(dto.lines[1].procComp).toBe('Licitación');
    expect(dto.lines[1].impAhorro).toBe(27645);
    expect(dto.lines[2].clasGts).toBeNull();
    expect(dto.lines[3].clasGts).toBeNull();
  });

  it('agregados: linesClassified cuenta capturas reales; ahorroTotal null sin capturas (T10)', () => {
    const sinCaptura = toSapPurchaseOrder(poDoc());
    expect(sinCaptura.linesTotal).toBe(1);
    expect(sinCaptura.linesClassified).toBe(0);
    expect(sinCaptura.ahorroTotal).toBeNull(); // nunca 0 inventado

    const conCaptura = toSapPurchaseOrder(
      poDoc({
        DocumentLines: [
          line({ U_Clas_gts: 'OPEX', U_Imp_ahorro: 100.25 }),
          line({ LineNum: 1, U_Imp_ahorro: 0 }), // 0 capturado ES un valor real
          line({ LineNum: 2 }),
        ],
      }),
    );
    expect(conCaptura.linesClassified).toBe(1);
    expect(conCaptura.ahorroTotal).toBe(100.25);
  });

  it('DocEntry ausente o no numérico → SapMappingError', () => {
    expect(() => toSapPurchaseOrder(poDoc({ DocEntry: null }))).toThrow(
      SapMappingError,
    );
    expect(() => toSapPurchaseOrder(poDoc({ DocEntry: 'abc' }))).toThrow(
      SapMappingError,
    );
    expect(() => toSapPurchaseOrder('no-es-objeto')).toThrow(SapMappingError);
  });
});

describe('sap.mapper — PurchaseRequests', () => {
  it('docTotal = suma de LineTotal (el SL no permite $select=DocTotal) y currency de la primera línea', () => {
    const dto = toSapPurchaseRequest({
      DocEntry: 300,
      DocNum: 234,
      Requester: 'abnuser27',
      RequesterName: 'Solicitante Uno',
      RequriedDate: '2026-09-18T00:00:00Z',
      DocumentLines: [
        line({ LineTotal: 29631, Currency: 'MXN' }),
        line({ LineNum: 1, LineTotal: 369, Currency: 'MXN' }),
        line({ LineNum: 2, LineTotal: null }),
      ],
    });
    expect(dto.docTotal).toBe(30000);
    expect(dto.currency).toBe('MXN');
    expect(dto.requester).toBe('abnuser27');
    expect(dto.requiredDate).toBe('2026-09-18T00:00:00Z');
  });

  it('sin líneas: docTotal y currency quedan null (no 0)', () => {
    const dto = toSapPurchaseRequest({ DocEntry: 301, DocumentLines: [] });
    expect(dto.docTotal).toBeNull();
    expect(dto.currency).toBeNull();
    expect(dto.linesTotal).toBe(0);
  });
});

describe('sap.mapper — BusinessPartners (proveedores)', () => {
  it('mapea básicos y convierte tYES/tNO a boolean; otros valores → null', () => {
    const dto = toSapBusinessPartner({
      CardCode: 'P0000788',
      CardName: 'PROVEEDOR UNO SA DE CV',
      CardType: 'cSupplier',
      FederalTaxID: 'PUN010101AAA',
      EmailAddress: 'ventas@proveedor.mx',
      Phone1: '5511122233',
      ContactPerson: 'María López',
      Currency: '##',
      Valid: 'tYES',
      Frozen: 'tNO',
      UpdateDate: '2026-09-01T00:00:00Z',
    });
    expect(dto.cardCode).toBe('P0000788');
    expect(dto.federalTaxId).toBe('PUN010101AAA');
    expect(dto.currency).toBe('##'); // multimoneda: el valor crudo se conserva
    expect(dto.sapValid).toBe(true);
    expect(dto.sapFrozen).toBe(false);

    const nulos = toSapBusinessPartner({ CardCode: 'E1', Valid: 'quizas' });
    expect(nulos.sapValid).toBeNull();
    expect(nulos.federalTaxId).toBeNull();
  });

  it('CardCode ausente → SapMappingError', () => {
    expect(() => toSapBusinessPartner({ CardName: 'X' })).toThrow(
      SapMappingError,
    );
  });
});

describe('sap.mapper — hash de cambio', () => {
  it('mismo raw → mismo hash; cualquier cambio → hash distinto', () => {
    const a = poDoc();
    expect(sapRawHash(a)).toBe(sapRawHash(poDoc()));
    expect(sapRawHash(a)).not.toBe(sapRawHash(poDoc({ DocTotal: 1 })));
    expect(sapRawHash(a)).toHaveLength(64); // sha256 hex
  });
});

/**
 * Sprint 2026-09-22 — mapper SAP: (A6) campos de cancelación/autorización/
 * cierre y (B5) solicitudes de autorización enriquecidas con catálogos.
 * Sin catálogo o sin dato → null, nunca se inventa.
 */
import type { SapApprovalCatalogs } from './dto/sap-document.dto';
import {
  SAP_MAPPER_VERSION,
  sapRawHash,
  toSapApprovalRequest,
  toSapPurchaseOrder,
  toSapPurchaseRequest,
} from './sap.mapper';
import { SapMappingError } from './sap.errors';

describe('sap.mapper — A6: Cancelled / AuthorizationStatus / ClosingDate', () => {
  it('sube la versión del mapper (las filas viejas se re-sincronizan con full)', () => {
    expect(SAP_MAPPER_VERSION).toBe('1.1.1');
  });

  it('tYES/tNO → boolean; una cancelada conserva DocumentStatus=bost_Close pero cancelled=true', () => {
    const po = toSapPurchaseOrder({
      DocEntry: 1,
      DocumentStatus: 'bost_Close',
      Cancelled: 'tYES',
      CancelStatus: 'csYes',
      AuthorizationStatus: 'dasApproved',
      Confirmed: 'tNO',
      ClosingDate: '2026-09-01T00:00:00Z',
      DocumentLines: [],
    });
    expect(po.documentStatus).toBe('bost_Close');
    expect(po.cancelled).toBe(true);
    expect(po.cancelStatus).toBe('csYes');
    expect(po.authorizationStatus).toBe('dasApproved');
    expect(po.confirmed).toBe(false);
    expect(po.closingDate).toBe('2026-09-01T00:00:00Z');
  });

  it('sin los campos (raw previo a 0011) → null en todos, también en solicitudes', () => {
    const pr = toSapPurchaseRequest({ DocEntry: 2, DocumentLines: [] });
    expect(pr.cancelled).toBeNull();
    expect(pr.cancelStatus).toBeNull();
    expect(pr.authorizationStatus).toBeNull();
    expect(pr.confirmed).toBeNull();
    expect(pr.closingDate).toBeNull();
    // Valores fuera del vocabulario tampoco se interpretan
    expect(
      toSapPurchaseOrder({ DocEntry: 3, Cancelled: 'maybe' }).cancelled,
    ).toBeNull();
  });

  it('los campos nuevos entran al hash: mismo documento con Cancelled distinto → hash distinto', () => {
    const base = {
      DocEntry: 9,
      DocumentStatus: 'bost_Close',
      Cancelled: 'tNO',
    };
    expect(sapRawHash(base)).not.toBe(
      sapRawHash({ ...base, Cancelled: 'tYES' }),
    );
  });
});

describe('sap.mapper — B5: toSapApprovalRequest', () => {
  const catalogs: SapApprovalCatalogs = {
    drafts: new Map([
      [
        610,
        {
          DocNum: 320,
          DocDate: '2026-09-22T00:00:00Z',
          DocTotal: 18090.04,
          DocCurrency: 'MXN',
          CardName: null,
          RequesterName: 'Ollin Marcela HERRERA',
          DocObjectCode: 'oPurchaseRequest',
        },
      ],
    ]),
    users: new Map([
      [33, 'Ingrid Torres'],
      [44, 'Ollin Herrera'],
    ]),
    stages: new Map([[18, 'Aut. SolPed nivel 1']]),
    templates: new Map([[16, 'SOLPED OPERACION']]),
  };

  const raw = {
    Code: 572,
    ApprovalTemplatesID: 16,
    ObjectType: '1470000113',
    IsDraft: 'Y',
    ObjectEntry: null,
    Status: 'arsPending',
    Remarks: 'RENOVACION DE EQUIPOS',
    CurrentStage: 18,
    OriginatorID: 44,
    CreationDate: '2026-09-22T00:00:00Z',
    DraftEntry: 610,
    DraftType: '112',
    ApprovalRequestLines: [
      {
        StageCode: 18,
        UserID: 33,
        Status: 'ardPending',
        UpdateDate: '2026-09-22T00:00:00Z',
      },
      { StageCode: 18, UserID: 56, Status: 'ardPending', UpdateDate: null },
    ],
  };

  it('enriquece con borrador, usuarios, etapas y plantilla; desconocidos → null', () => {
    const dto = toSapApprovalRequest(raw, catalogs);
    expect(dto.code).toBe(572);
    expect(dto.templateName).toBe('SOLPED OPERACION');
    expect(dto.objectType).toBe('1470000113');
    expect(dto.isDraft).toBe(true);
    expect(dto.draftEntry).toBe(610);
    expect(dto.status).toBe('arsPending');
    expect(dto.currentStageName).toBe('Aut. SolPed nivel 1');
    expect(dto.originatorName).toBe('Ollin Herrera');
    // Datos del borrador
    expect(dto.docNum).toBe(320);
    expect(dto.docTotal).toBe(18090.04);
    expect(dto.currency).toBe('MXN');
    expect(dto.requesterName).toBe('Ollin Marcela HERRERA');
    expect(dto.cardName).toBeNull();
    // Aprobadores: el 56 no está en el catálogo → userName null (no se inventa)
    expect(dto.approvers).toEqual([
      {
        stageCode: 18,
        stageName: 'Aut. SolPed nivel 1',
        userId: 33,
        userName: 'Ingrid Torres',
        status: 'ardPending',
        updateDate: '2026-09-22T00:00:00Z',
      },
      {
        stageCode: 18,
        stageName: 'Aut. SolPed nivel 1',
        userId: 56,
        userName: null,
        status: 'ardPending',
        updateDate: null,
      },
    ]);
  });

  it('sin borrador en el catálogo: los campos del documento quedan null', () => {
    const dto = toSapApprovalRequest({ ...raw, DraftEntry: 9999 }, catalogs);
    expect(dto.draftEntry).toBe(9999);
    expect(dto.docNum).toBeNull();
    expect(dto.docTotal).toBeNull();
    expect(dto.requesterName).toBeNull();
  });

  it('Code ausente → SapMappingError; IsDraft fuera de Y/N → null', () => {
    expect(() =>
      toSapApprovalRequest({ Status: 'arsPending' }, catalogs),
    ).toThrow(SapMappingError);
    expect(
      toSapApprovalRequest({ ...raw, IsDraft: 'X' }, catalogs).isDraft,
    ).toBeNull();
  });
});

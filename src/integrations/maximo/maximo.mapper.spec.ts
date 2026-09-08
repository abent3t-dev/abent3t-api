import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { MaximoContractDto } from './dto/maximo-contract.dto';
import { MaximoPurchaseOrderDto } from './dto/maximo-po.dto';
import { MaximoMappingError, MaximoResponseShapeError } from './maximo.errors';
import {
  MaximoMapper,
  parseLegacyEnvelope,
  parseOslcEnvelope,
  toCanonical,
  toContract,
  toPurchaseOrder,
} from './maximo.mapper';

/**
 * Fase INT-2. Todos los fixtures son respuestas reales SANITIZADAS (ver
 * __fixtures__/README.md); los marcados SYNTHETIC se construyeron a mano.
 * Ningún test toca la red.
 */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '__fixtures__', name), 'utf8'));

const legacyRecords = (name: string, os: 'AB_COMPRAS' | 'AB_CONTRATOS') =>
  parseLegacyEnvelope(fixture(name), os).records;
const oslcRecords = (name: string) => parseOslcEnvelope(fixture(name)).records;

/** Recorre el DTO y devuelve las rutas cuyo valor es `undefined`. */
function undefinedPaths(value: unknown, path = '$'): string[] {
  if (value === undefined) return [path];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => undefinedPaths(v, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      undefinedPaths(v, `${path}.${k}`),
    );
  }
  return [];
}

describe('toCanonical', () => {
  it('desenvuelve {content} del legacy anidado y normaliza rowstamp/hijos', () => {
    const raw = {
      rowstamp: '1',
      Attributes: { PONUM: { content: 'PO1' }, TOTALCOST: { content: 5 } },
      RelatedMbos: {
        POLINE: [{ rowstamp: '2', Attributes: { POLINENUM: { content: 1 } } }],
      },
    };
    expect(toCanonical(raw)).toEqual({
      ROWSTAMP: '1',
      PONUM: 'PO1',
      TOTALCOST: 5,
      POLINE: [{ ROWSTAMP: '2', POLINENUM: 1 }],
    });
  });

  it('normaliza OSLC lean: claves a mayúsculas, "~null~" → null, metadatos fuera', () => {
    const raw = {
      ponum: 'PO1',
      _rowstamp: '9',
      href: 'http://maximo.example/x',
      localref: 'http://maximo.example/y',
      poline_collectionref: 'http://maximo.example/z',
      ab_clasfpo_description: null,
      poline: [{ item: [{ description: '~null~', itemnum: 'A' }] }],
    };
    expect(toCanonical(raw)).toEqual({
      PONUM: 'PO1',
      ROWSTAMP: '9',
      AB_CLASFPO_DESCRIPTION: null,
      POLINE: [{ ITEM: [{ DESCRIPTION: null, ITEMNUM: 'A' }] }],
    });
  });

  it('rechaza valores que no son objetos', () => {
    expect(() => toCanonical('x')).toThrow(MaximoMappingError);
    expect(() => toCanonical(null)).toThrow(MaximoMappingError);
  });
});

describe('parseLegacyEnvelope / parseOslcEnvelope', () => {
  it('extrae PO[] y los contadores rsStart/rsCount/rsTotal de una página', () => {
    const { records, page } = parseLegacyEnvelope(
      fixture('ab-compras.legacy-nested.page.json'),
      'AB_COMPRAS',
    );
    expect(records).toHaveLength(2);
    expect(page).toEqual({ rsStart: 0, rsCount: 2, rsTotal: 4892 });
  });

  it('filtro por igualdad: rsTotal ausente → null', () => {
    const { page } = parseLegacyEnvelope(
      fixture('ab-compras.legacy-nested.ponum-filter.json'),
      'AB_COMPRAS',
    );
    expect(page).toEqual({ rsStart: 0, rsCount: 1, rsTotal: null });
  });

  it('conjunto vacío (AB_COMPRASSet: {}) → records [] sin error', () => {
    const { records, page } = parseLegacyEnvelope(
      fixture('ab-compras.legacy.empty.json'),
      'AB_COMPRAS',
    );
    expect(records).toEqual([]);
    expect(page.rsCount).toBe(0);
  });

  it('acepta la raíz PURCHVIEW de la estructura previa de AB_CONTRATOS', () => {
    const { records } = parseLegacyEnvelope(
      fixture('ab-contratos.legacy-compact.purchview-root.v1.json'),
      'AB_CONTRATOS',
    );
    expect(records).toHaveLength(2);
  });

  it('sobre legacy con forma inesperada lanza MaximoResponseShapeError', () => {
    expect(() => parseLegacyEnvelope({}, 'AB_COMPRAS')).toThrow(
      MaximoResponseShapeError,
    );
    expect(() =>
      parseLegacyEnvelope(fixture('ab-compras.oslc.range.json'), 'AB_COMPRAS'),
    ).toThrow(/QueryAB_COMPRASResponse/);
  });

  it('OSLC: extrae member[] y responseInfo (paginación sintética)', () => {
    const real = parseOslcEnvelope(fixture('ab-compras.oslc.range.json'));
    expect(real.records).toHaveLength(3);
    expect(real.page).toEqual({
      totalCount: null,
      nextPageHref: null,
      pageNum: null,
    });

    const paged = parseOslcEnvelope(
      fixture('ab-compras.oslc.page.SYNTHETIC.json'),
    );
    expect(paged.records).toHaveLength(2);
    expect(paged.page.totalCount).toBe(8);
    expect(paged.page.pageNum).toBe(1);
    expect(paged.page.nextPageHref).toContain('pageno=2');
  });

  it('OSLC: un {Error} BMXAA8781E lanza MaximoResponseShapeError con reasonCode', () => {
    let thrown: MaximoResponseShapeError | undefined;
    try {
      parseOslcEnvelope(fixture('oslc.error.bmxaa8781e.json'));
    } catch (e: unknown) {
      thrown = e as MaximoResponseShapeError;
    }
    expect(thrown).toBeInstanceOf(MaximoResponseShapeError);
    expect(thrown!.reasonCode).toBe('BMXAA8781E');
    expect(thrown!.message).toContain('invalid query term');
  });
});

describe('toPurchaseOrder (AB_COMPRAS)', () => {
  it('PO histórica (legacy anidado) SIN campos AB_*: todos null, resto poblado', () => {
    const [po] = legacyRecords(
      'ab-compras.legacy-nested.page.json',
      'AB_COMPRAS',
    ).map(toPurchaseOrder);

    expect(po.erp).toBe('Maximo');
    expect(po.ponum).toBe('PO100012');
    expect(po.status).toBe('CLOSE');
    expect(po.description).toContain('Configuración OPC');
    expect(po.orderDate).toBe('2019-07-01T23:29:54+00:00');
    expect(po.currencyCode).toBe('USD');
    expect(po.totalCost).toBe(7193.16);
    expect(po.pretaxTotal).toBeNull();
    expect(po.abAhorro).toBeNull();
    expect(po.abTipoComp).toBeNull();
    expect(po.abClasfPo).toBeNull();
    expect(po.area).toBe('Administración');
    expect(po.buyer?.displayName).toMatch(/^Persona Demo \d+$/);
    expect(po.vendor?.name).toBe('ABB MEXICO SA DE CV');
    expect(po.lines).toHaveLength(1);
    expect(po.lines[0].pr?.prnum).toBe('PR100014');
    expect(po.prnum).toBe('PR100014');
    expect(po.prIssueDate).toBe('2019-06-25T15:28:46+00:00');
    expect(po.statusHistory.length).toBeGreaterThanOrEqual(2);
    // Historial ordenado ascendente y fechas derivadas coherentes con él
    const dates = po.statusHistory.map((h) => h.changeDate ?? '');
    expect([...dates].sort()).toEqual(dates);
    expect(po.waitingApprovalDate).toBe(
      po.statusHistory.find((h) => h.status === 'WAPPR')?.changeDate ?? null,
    );
    expect(po.approvedDate).toBe(
      po.statusHistory.find((h) => h.status === 'APPR')?.changeDate ?? null,
    );
  });

  it('PO completa (legacy compacto) CON AB_AHORRO / AB_TIPOCOMP / AB_CLASFPO', () => {
    const [po] = legacyRecords(
      'ab-compras.legacy-compact.po102249.json',
      'AB_COMPRAS',
    ).map(toPurchaseOrder);

    expect(po.ponum).toBe('PO102249');
    expect(po.abAhorro).toBe(27645);
    expect(po.abTipoComp).toBe('CL');
    expect(po.abClasfPo).toBe('CAPEX');
    expect(po.pretaxTotal).toBe(368085);
    expect(po.totalCost).toBe(426978.6);
    expect(po.currencyCode).toBe('USD');
    expect(po.area).toBe('A3T');
    expect(po.vendor?.name).toBe('FLUIDS TECH SA DE CV');
    expect(po.vendor?.orgId).toBe('N28');
    expect(po.prnum).toBe('PR102826');
    expect(po.requestedBy).toBe('MAXADMIN');
    expect(po.prIssueDate).toBe('2026-06-05T12:35:06+00:00');
    expect(po.prStatusDate).toBe('2026-06-05T12:38:27+00:00');
    expect(po.waitingApprovalDate).toBe('2026-06-05T12:38:27+00:00');
    expect(po.approvedDate).toBeNull(); // nunca aprobada (solo WAPPR)
    expect(po.lines).toHaveLength(2);
    expect(po.lines[0].itemDescription).toContain('EMPAQUE');
    expect(po.rowstamp).toBe('493819741');
  });

  it('ambas APIs producen el MISMO DTO para PO102249 (legacy compacto ≡ OSLC)', () => {
    const [legacy] = legacyRecords(
      'ab-compras.legacy-compact.po102249.json',
      'AB_COMPRAS',
    ).map(toPurchaseOrder);
    const [oslc] = oslcRecords('ab-compras.oslc.po102249.json').map(
      toPurchaseOrder,
    );
    expect(oslc).toEqual(legacy);
    // Cobertura real de la equivalencia: estos campos van poblados…
    for (const po of [legacy, oslc]) {
      expect(po.abAhorro).not.toBeNull();
      expect(po.totalCost).not.toBeNull();
      expect(po.orderDate).not.toBeNull();
      expect(po.vendor).not.toBeNull();
      expect(po.prnum).not.toBeNull();
    }
    // …y estos son null EN AMBAS por limitación de la captura (jun-2026,
    // previa al fix de CIISA que subió STATUS/DESCRIPTION a la raíz): si un
    // fixture OSLC posterior los trae, este assert obliga a revisar la
    // equivalencia de verdad. Pendiente Int-3: captura OSLC post-13-ago.
    expect(legacy.status).toBeNull();
    expect(legacy.description).toBeNull();
    expect(legacy.approvedDate).toBeNull();
  });

  it('rango: los POs comunes a legacy compacto y OSLC dan DTOs idénticos', () => {
    const legacy = new Map(
      legacyRecords('ab-compras.legacy-compact.range.json', 'AB_COMPRAS')
        .map(toPurchaseOrder)
        .map((po) => [po.ponum, po]),
    );
    const oslc = oslcRecords('ab-compras.oslc.range.json').map(toPurchaseOrder);
    const common = oslc.filter((po) => legacy.has(po.ponum));
    expect(common.length).toBeGreaterThan(0);
    for (const po of common) expect(po).toEqual(legacy.get(po.ponum));
    // "~null~" en ITEM.DESCRIPTION → null
    expect(oslc[0].lines[0].itemDescription).toBeNull();
  });

  it('campos omitidos en el JSON crudo aparecen como null (nunca undefined)', () => {
    const pos: MaximoPurchaseOrderDto[] = [
      ...legacyRecords('ab-compras.legacy-nested.page.json', 'AB_COMPRAS'),
      ...legacyRecords(
        'ab-compras.legacy-nested.ponum-filter.json',
        'AB_COMPRAS',
      ),
      ...legacyRecords('ab-compras.legacy-compact.range.json', 'AB_COMPRAS'),
      ...oslcRecords('ab-compras.oslc.range.json'),
    ].map(toPurchaseOrder);
    for (const po of pos) expect(undefinedPaths(po)).toEqual([]);
    // Registro mínimo: solo PONUM
    const minimal = toPurchaseOrder({ PONUM: 'PO-MIN' });
    expect(undefinedPaths(minimal)).toEqual([]);
    expect(minimal.lines).toEqual([]);
    expect(minimal.buyer).toBeNull();
    expect(minimal.vendor).toBeNull();
    expect(minimal.area).toBeNull();
  });

  it('PERSON.STATUS (persona INACTIVE) no se filtra a ningún campo del PO', () => {
    const pos = legacyRecords(
      'ab-compras.legacy-nested.page.json',
      'AB_COMPRAS',
    ).map(toPurchaseOrder);
    // PO100012 trae PERSON (con STATUS=INACTIVE); PO100026 no trae PERSON.
    expect(pos.map((po) => po.buyer !== null)).toEqual([true, false]);
    for (const po of pos) {
      expect(JSON.stringify(po)).not.toContain('INACTIVE');
      if (po.buyer) {
        expect(Object.keys(po.buyer)).toEqual([
          'personId',
          'displayName',
          'department',
        ]);
      }
    }
    expect(pos[1].area).toBeNull();
  });

  it('sin PONUM lanza MaximoMappingError', () => {
    expect(() => toPurchaseOrder({ SITEID: 'A3T' })).toThrow(
      MaximoMappingError,
    );
    expect(() => toPurchaseOrder({ SITEID: 'A3T' })).toThrow(/PONUM/);
  });
});

describe('toContract (AB_CONTRATOS)', () => {
  const allContractFixtures = (): MaximoContractDto[] => [
    ...legacyRecords(
      'ab-contratos.legacy-compact.pr102828.json',
      'AB_CONTRATOS',
    ).map(toContract),
    ...oslcRecords('ab-contratos.oslc.pr102828.json').map(toContract),
    ...legacyRecords(
      'ab-contratos.legacy-nested.no-contract.json',
      'AB_CONTRATOS',
    ).map(toContract),
    ...legacyRecords(
      'ab-contratos.legacy-compact.purchview-root.v1.json',
      'AB_CONTRATOS',
    ).map(toContract),
    ...legacyRecords(
      'ab-contratos.legacy-compact.wappr.SYNTHETIC.json',
      'AB_CONTRATOS',
    ).map(toContract),
  ];

  it('PR CON contrato (PURCHVIEW + COMPANIES + CONTRACTSTATUS + CONTRACTLINE + PERSON)', () => {
    const [c] = legacyRecords(
      'ab-contratos.legacy-compact.pr102828.json',
      'AB_CONTRATOS',
    ).map(toContract);

    expect(c.erp).toBe('Maximo');
    expect(c.expenseType).toBe('OPEX');
    expect(c.prnum).toBe('PR102828');
    expect(c.requestedBy).toBe('MAXADMIN');
    expect(c.area).toBe('TI');
    expect(c.hasContract).toBe(true);
    expect(c.contractNum).toBe('1091');
    expect(c.currencyCode).toBe('MXN');
    expect(c.startDate).toBe('2026-06-05T00:00:00+00:00');
    expect(c.endDate).toBe('2027-06-05T00:00:00+00:00');
    expect(c.totalCost).toBe(58470.5);
    expect(c.maxVol).toBeNull(); // la OS actual no lo expone
    expect(c.vendor?.name).toBe('Graco Mexicana S.A. de C.V.');
    expect(c.lines).toHaveLength(2);
    expect(c.lines[0].itemNum).toBe('2001259');
    expect(c.lines[0].description).toContain('AMINA');
    expect(new Set(c.statusHistory.map((h) => h.status))).toEqual(
      new Set(['DRAFT', 'APPR']),
    );
    expect(c.status).toBe(c.statusHistory[c.statusHistory.length - 1].status);
    expect(c.approvedDate).toBe(
      c.statusHistory.find((h) => h.status === 'APPR')?.changeDate ?? null,
    );
    expect(c.approvedDate).not.toBeNull();
    expect(c.createdDate).toBeNull(); // sin WAPPR en el historial real
    expect(c.createdDateRule).toBeNull();
  });

  it('ambas APIs producen el MISMO DTO para PR102828 (legacy compacto ≡ OSLC)', () => {
    const [legacy] = legacyRecords(
      'ab-contratos.legacy-compact.pr102828.json',
      'AB_CONTRATOS',
    ).map(toContract);
    const [oslc] = oslcRecords('ab-contratos.oslc.pr102828.json').map(
      toContract,
    );
    expect(oslc).toEqual(legacy);
  });

  it('PR SIN contrato (solo cabecera + PERSON): DTO válido con hasContract=false', () => {
    const contracts = legacyRecords(
      'ab-contratos.legacy-nested.no-contract.json',
      'AB_CONTRATOS',
    ).map(toContract);
    expect(contracts).toHaveLength(2);
    const [c] = contracts;
    expect(c.prnum).toBe('PR100026');
    expect(c.requestedBy).toMatch(/^USR\d{3}$/);
    expect(c.area).toBe('Mantenimiento');
    expect(c.requester?.displayName).toMatch(/^Persona Demo \d+$/);
    expect(c.hasContract).toBe(false);
    expect(c.contractNum).toBeNull();
    expect(c.startDate).toBeNull();
    expect(c.totalCost).toBeNull();
    expect(c.vendor).toBeNull();
    expect(c.lines).toEqual([]);
    expect(c.statusHistory).toEqual([]);
    expect(c.status).toBeNull();
    expect(c.approvedDate).toBeNull();
  });

  it('PERSON.STATUS (INACTIVE) jamás termina en el estatus del contrato', () => {
    const contracts = legacyRecords(
      'ab-contratos.legacy-nested.no-contract.json',
      'AB_CONTRATOS',
    ).map(toContract);
    for (const c of contracts) {
      expect(c.status).toBeNull();
      expect(JSON.stringify(c)).not.toContain('INACTIVE');
    }
    // Incluso si PERSON.STATUS fuera 'APPR', no cuenta como estatus de contrato
    const tricky = toContract({
      PRNUM: 'PR-X',
      PERSON: [{ PERSONID: 'U', STATUS: 'APPR', STATUSDATE: '2026-01-01' }],
    });
    expect(tricky.status).toBeNull();
    expect(tricky.approvedDate).toBeNull();
  });

  it('estructura previa (raíz PURCHVIEW, con MAXVOL): maxVol se mapea, contractValue NO', () => {
    // Dos revisiones del contrato 1040: solo la revisión 1 trae MAXVOL.
    const contracts = legacyRecords(
      'ab-contratos.legacy-compact.purchview-root.v1.json',
      'AB_CONTRATOS',
    ).map(toContract);
    expect(contracts).toHaveLength(2);
    for (const c of contracts) {
      expect(c.hasContract).toBe(true);
      expect(c.prnum).toBeNull();
      expect(c.contractNum).toBe('1040');
      expect(c.contractValue).toBeNull(); // §20.2: nunca desde MAXVOL
      expect(c.contractRefNum).toBeNull(); // §20.2: nunca desde CONTRACTNUM
      expect(c.lines).toHaveLength(2);
      expect(c.lines[0].itemNum).toBe('TST1ACIDO');
    }
    expect(contracts.map((c) => c.revisionNum)).toEqual([0, 1]);
    expect(contracts.map((c) => c.maxVol)).toEqual([null, 62385]);
    expect(contracts.map((c) => c.totalCost)).toEqual([62368.5, 62385]);
    // WAPPR REAL (rev 1: PNDREV → WAPPR): regla de fecha de creación aplicada.
    expect(contracts[0].createdDate).toBeNull(); // rev 0: DRAFT → APPR
    expect(contracts[0].createdDateRule).toBeNull();
    expect(contracts[0].approvedDate).toBe('2024-03-01T09:39:43+00:00');
    expect(contracts[0].status).toBe('APPR');
    expect(contracts[1].createdDate).toBe('2024-08-29T11:03:09+00:00');
    expect(contracts[1].createdDateRule).toBe('WAPPR');
    expect(contracts[1].approvedDate).toBeNull();
    expect(contracts[1].status).toBe('WAPPR');
    // En raíz PURCHVIEW, rowstamp y contractRowstamp son la misma fila.
    expect(contracts[0].contractRowstamp).toBe(contracts[0].rowstamp);
  });

  it('varias PURCHVIEW bajo un PR: se mapea la de mayor REVISIONNUM y se expone purchviewCount', () => {
    const c = toContract({
      PRNUM: 'PR-MULTI',
      PURCHVIEW: [
        { rowstamp: 'A', CONTRACTNUM: '9', REVISIONNUM: 0, TOTALCOST: 10 },
        { rowstamp: 'B', CONTRACTNUM: '9', REVISIONNUM: 1, TOTALCOST: 20 },
      ],
    });
    expect(c.purchviewCount).toBe(2);
    expect(c.revisionNum).toBe(1);
    expect(c.totalCost).toBe(20);
    expect(c.contractRowstamp).toBe('B');
    // Y el DTO expone AMBOS rowstamps: el del PR y el de la PURCHVIEW mapeada.
    const [single] = legacyRecords(
      'ab-contratos.legacy-compact.pr102828.json',
      'AB_CONTRATOS',
    ).map(toContract);
    expect(single.purchviewCount).toBe(1);
    expect(single.rowstamp).toBe('493821559');
    expect(single.contractRowstamp).toBe('493821280,493821300');
  });

  it('semántica de aprobación: APPR literal y PRIMERA ocurrencia (patrón 1037: APPR→SUSPND→APPR)', () => {
    const c = toContract({
      PRNUM: 'PR-1037',
      PURCHVIEW: [
        {
          CONTRACTNUM: '1037',
          REVISIONNUM: 0,
          CONTRACTSTATUS: [
            { STATUS: 'DRAFT', CHANGEDATE: '2024-01-01T10:00:00+00:00' },
            { STATUS: 'APPR', CHANGEDATE: '2024-01-02T10:00:00+00:00' },
            { STATUS: 'SUSPND', CHANGEDATE: '2024-02-01T10:00:00+00:00' },
            { STATUS: 'APPR', CHANGEDATE: '2024-03-01T10:00:00+00:00' },
          ],
        },
      ],
    });
    expect(c.approvedDate).toBe('2024-01-02T10:00:00+00:00'); // primera APPR
    expect(c.status).toBe('APPR'); // última por fecha
    // Sinónimos por nivel (evidencia v1: 1068/1064 sin APPR literal) NO se
    // infieren — igual que §20.2, pendiente de confirmación con Isaac.
    const levels = toContract({
      PRNUM: 'PR-1064',
      PURCHVIEW: [
        {
          CONTRACTNUM: '1064',
          CONTRACTSTATUS: [
            { STATUS: 'DRAFT', CHANGEDATE: '2024-01-01T10:00:00+00:00' },
            { STATUS: 'WAPPR', CHANGEDATE: '2024-01-02T10:00:00+00:00' },
            { STATUS: 'APPR1', CHANGEDATE: '2024-01-03T10:00:00+00:00' },
          ],
        },
      ],
    });
    expect(levels.approvedDate).toBeNull();
    expect(levels.status).toBe('APPR1');
  });

  it('empate de CHANGEDATE en el historial: desempata el id monótono de la fila', () => {
    const c = toContract({
      PRNUM: 'PR-TIE',
      PURCHVIEW: [
        {
          CONTRACTSTATUS: [
            // Mismo segundo, ids en orden inverso al de llegada.
            {
              STATUS: 'APPR',
              CHANGEDATE: '2024-05-01T12:00:00+00:00',
              CONTRACTSTATUSID: 20,
            },
            {
              STATUS: 'WAPPR',
              CHANGEDATE: '2024-05-01T12:00:00+00:00',
              CONTRACTSTATUSID: 10,
            },
          ],
        },
      ],
    });
    expect(c.statusHistory.map((h) => h.status)).toEqual(['WAPPR', 'APPR']);
    expect(c.status).toBe('APPR');
  });

  it('SYNTHETIC: historial DRAFT → WAPPR → APPR deriva createdDate (regla WAPPR) y approvedDate', () => {
    const [c] = legacyRecords(
      'ab-contratos.legacy-compact.wappr.SYNTHETIC.json',
      'AB_CONTRATOS',
    ).map(toContract);
    expect(c.prnum).toBe('PR104531');
    expect(c.contractNum).toBe('1104');
    expect(c.createdDate).toBe('2026-06-21T09:30:00+00:00');
    expect(c.createdDateRule).toBe('WAPPR');
    expect(c.approvedDate).toBe('2026-06-25T16:45:00+00:00');
    expect(c.status).toBe('APPR');
    expect(c.statusHistory.map((h) => h.status)).toEqual([
      'DRAFT',
      'WAPPR',
      'APPR',
    ]);
  });

  it('CONTRACTREFNUM / CONTRACTVALUE quedan null con TODOS los fixtures actuales', () => {
    for (const c of allContractFixtures()) {
      expect(c.contractRefNum).toBeNull();
      expect(c.contractValue).toBeNull();
    }
  });

  it('CONTRACTREFNUM / CONTRACTVALUE se mapean SOLO si llegan con ese nombre exacto', () => {
    const c = toContract({
      PRNUM: 'PR-Y',
      PURCHVIEW: [
        {
          CONTRACTNUM: '77',
          CONTRACTREFNUM: 'REF-77',
          CONTRACTVALUE: '1200.5',
        },
      ],
    });
    expect(c.contractRefNum).toBe('REF-77');
    expect(c.contractValue).toBe(1200.5);
    expect(c.contractNum).toBe('77');
  });

  it('campos omitidos aparecen como null (nunca undefined) en todos los fixtures', () => {
    for (const c of allContractFixtures())
      expect(undefinedPaths(c)).toEqual([]);
  });

  it('sin PRNUM ni PURCHVIEW lanza MaximoMappingError', () => {
    expect(() => toContract({ SITEID: 'A3T' })).toThrow(MaximoMappingError);
  });
});

describe('sanidad de los fixtures (sanitización)', () => {
  it('ningún childkey OSLC codifica un PERSONID real (base64 con "-" de padding)', () => {
    const files = readdirSync(join(__dirname, '__fixtures__')).filter((f) =>
      f.endsWith('.json'),
    );
    expect(files.length).toBeGreaterThanOrEqual(14);
    for (const file of files) {
      const text = readFileSync(join(__dirname, '__fixtures__', file), 'utf8');
      expect(text).not.toMatch(/MAXAUTH|Authorization/i);
      expect(text).not.toMatch(/southcentralus/);
      for (const match of text.matchAll(/childkey#([A-Za-z0-9+/=-]+)/g)) {
        const decoded = Buffer.from(
          match[1].replace(/-/g, '='),
          'base64',
        ).toString('utf8');
        if (!decoded.includes('PERSON')) continue;
        const personId = decoded.split('/').pop() ?? '';
        expect(personId).toMatch(/^(USR\d{3}|MAXADMIN)$/);
      }
    }
  });
});

describe('MaximoMapper (agrupador)', () => {
  it('expone las funciones puras', () => {
    expect(MaximoMapper.toPurchaseOrder).toBe(toPurchaseOrder);
    expect(MaximoMapper.toContract).toBe(toContract);
    expect(MaximoMapper.parseLegacyEnvelope).toBe(parseLegacyEnvelope);
    expect(MaximoMapper.parseOslcEnvelope).toBe(parseOslcEnvelope);
    expect(MaximoMapper.toCanonical).toBe(toCanonical);
  });
});

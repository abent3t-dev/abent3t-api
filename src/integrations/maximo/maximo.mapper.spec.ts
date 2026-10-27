import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { canonicalize } from '../../common/maximo/maximo-canonical';
import { MaximoContractDto } from './dto/maximo-contract.dto';
import { MaximoPurchaseOrderDto } from './dto/maximo-po.dto';
import { MaximoMappingError, MaximoResponseShapeError } from './maximo.errors';
import {
  MAXIMO_MAPPER_VERSION,
  MaximoMapper,
  parseLegacyEnvelope,
  parseOslcEnvelope,
  subtotalOf,
  toCanonical,
  toContract,
  toContracts,
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

/** O (2026-10-26): RFQSTATUS, EXCHANGERATE y CONTRACTREFNUM (SYNTHETIC). */
const RQ_FIXTURE = 'ab-compras.legacy-nested.rq-tc-contrato.SYNTHETIC.json';

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
    expect(() => toCanonical([{ PONUM: 'PO1' }])).toThrow(
      'el registro no es un objeto',
    );
  });
});

describe('canonicalize (common, K3.7)', () => {
  it('con un no-objeto regresa null en lugar de lanzar', () => {
    for (const raw of ['x', 7, true, null, undefined, [{ PONUM: 'PO1' }]]) {
      expect(canonicalize(raw)).toBeNull();
    }
  });

  it('da lo mismo que toCanonical en las tres formas (el mapper la envuelve)', () => {
    const raws: unknown[] = [
      ...legacyRecords('ab-compras.legacy-nested.page.json', 'AB_COMPRAS'),
      ...legacyRecords('ab-compras.legacy-compact.po102249.json', 'AB_COMPRAS'),
      ...oslcRecords('ab-compras.oslc.po102249.json'),
      ...legacyRecords(
        'ab-contratos.legacy-nested.prstatus.SYNTHETIC.json',
        'AB_CONTRATOS',
      ),
    ];
    for (const raw of raws) expect(canonicalize(raw)).toEqual(toCanonical(raw));
  });

  it('el raw anidado de prod queda en la forma compacta (hijos incluidos)', () => {
    const nested = legacyRecords(
      'ab-contratos.legacy-nested.prstatus.SYNTHETIC.json',
      'AB_CONTRATOS',
    ).map(canonicalize);
    const compact = legacyRecords(
      'ab-contratos.legacy-compact.prstatus.SYNTHETIC.json',
      'AB_CONTRATOS',
    ).map(canonicalize);
    expect(nested).toEqual(compact);
    expect(nested[0]?.PRSTATUS).toHaveLength(3);
  });
});

describe('versión del mapper', () => {
  it('2026.10.26-2: RFQSTATUS también debajo de RFQLINE (O3; 10.26-1: comprador de la RQ, tipo de cambio y referencia de contrato)', () => {
    expect(MAXIMO_MAPPER_VERSION).toBe('2026.10.26-2');
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
      ...legacyRecords(
        'ab-compras.legacy-nested.po5-linecost.SYNTHETIC.json',
        'AB_COMPRAS',
      ),
      ...legacyRecords(RQ_FIXTURE, 'AB_COMPRAS'),
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
    ...legacyRecords(
      'ab-contratos.legacy-nested.prstatus.SYNTHETIC.json',
      'AB_CONTRATOS',
    ).flatMap(toContracts),
    ...legacyRecords(
      'ab-contratos.legacy-compact.prstatus.SYNTHETIC.json',
      'AB_CONTRATOS',
    ).flatMap(toContracts),
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

  it('estructura previa (raíz PURCHVIEW, con MAXVOL): maxVol se mapea, contractValue = TOTALCOST', () => {
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
      // §20.2 resuelta (Isaac): valor desde TOTALCOST, ref desde CONTRACTNUM.
      expect(c.contractValue).toBe(c.totalCost);
      expect(c.contractRefNum).toBe('1040');
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

  it('§20.2 resuelta: CONTRACTREFNUM/CONTRACTVALUE se derivan de CONTRACTNUM/TOTALCOST', () => {
    // Confirmación de Isaac (2026-09-21): con contrato, ref = contractNum y
    // valor = totalCost; sin contrato (PR sin PURCHVIEW), ambos null.
    for (const c of allContractFixtures()) {
      if (c.hasContract) {
        expect(c.contractRefNum).toBe(c.contractNum);
        expect(c.contractValue).toBe(c.totalCost);
      } else {
        expect(c.contractRefNum).toBeNull();
        expect(c.contractValue).toBeNull();
      }
    }
  });

  it('los nombres literales CONTRACTREFNUM / CONTRACTVALUE tienen precedencia si llegan', () => {
    const c = toContract({
      PRNUM: 'PR-Y',
      PURCHVIEW: [
        {
          CONTRACTNUM: '77',
          TOTALCOST: 999,
          CONTRACTREFNUM: 'REF-77',
          CONTRACTVALUE: '1200.5',
        },
      ],
    });
    expect(c.contractRefNum).toBe('REF-77');
    expect(c.contractValue).toBe(1200.5);
    expect(c.contractNum).toBe('77');
  });

  it('sin los literales, la derivación usa el PURCHVIEW (no la raíz PR)', () => {
    const c = toContract({
      PRNUM: 'PR-Z',
      PURCHVIEW: [{ CONTRACTNUM: '88', TOTALCOST: '450.25' }],
    });
    expect(c.contractRefNum).toBe('88');
    expect(c.contractValue).toBe(450.25);
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
    expect(files.length).toBeGreaterThanOrEqual(17);
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

  it('usuarios, nombres y notas solo con valores dummy (reales y SYNTHETIC)', () => {
    const userKeys = new Set([
      'PERSONID',
      'REQUESTEDBY',
      'PURCHASEAGENT',
      'CHANGEBY',
      'SUPERVISOR',
      'DELEGATE',
    ]);
    const files = readdirSync(join(__dirname, '__fixtures__')).filter((f) =>
      f.endsWith('.json'),
    );
    for (const file of files) {
      for (const raw of collectRecords(fixture(file))) {
        const rec = canonicalize(raw);
        for (const [key, value] of Object.entries(rec ?? {})) {
          if (typeof value !== 'string') continue;
          if (userKeys.has(key)) expect(value).toMatch(/^(USR\d{3}|MAXADMIN)$/);
          if (key === 'DISPLAYNAME') {
            expect(value).toMatch(/^(Persona Demo \d+|MAXADMIN)$/);
          }
          if (key === 'MEMO') expect(value).toMatch(/^Comentario de prueba/);
        }
      }
    }
  });
});

/** Todos los objetos de un fixture (a cualquier profundidad), para la sanidad. */
function collectRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(collectRecords);
  if (value === null || typeof value !== 'object') return [];
  return [value, ...Object.values(value).flatMap(collectRecords)];
}

describe('MaximoMapper (agrupador)', () => {
  it('expone las funciones puras', () => {
    expect(MaximoMapper.toPurchaseOrder).toBe(toPurchaseOrder);
    expect(MaximoMapper.toContract).toBe(toContract);
    expect(MaximoMapper.parseLegacyEnvelope).toBe(parseLegacyEnvelope);
    expect(MaximoMapper.parseOslcEnvelope).toBe(parseOslcEnvelope);
    expect(MaximoMapper.toCanonical).toBe(toCanonical);
  });
});

describe('comprador de la OC (E4, 2026-09-25)', () => {
  it('PURCHASEAGENT + DISPLAYNAME de su PERSON en las tres formas', () => {
    const [nested] = legacyRecords(
      'ab-compras.legacy-nested.page.json',
      'AB_COMPRAS',
    ).map(toPurchaseOrder);
    expect(nested.purchaseAgent).toBe('USR001');
    expect(nested.purchaseAgentName).toBe('Persona Demo 1');
    const [compact] = legacyRecords(
      'ab-compras.legacy-compact.po102249.json',
      'AB_COMPRAS',
    ).map(toPurchaseOrder);
    const [oslc] = oslcRecords('ab-compras.oslc.po102249.json').map(
      toPurchaseOrder,
    );
    expect(compact.purchaseAgentName).toBe('Persona Demo 4');
    expect(oslc.purchaseAgentName).toBe('Persona Demo 4');
  });

  it('sin PURCHASEAGENT o con otra PERSON no se nombra a nadie', () => {
    expect(toPurchaseOrder({ PONUM: 'PO-MIN' }).purchaseAgentName).toBeNull();
    const other = toPurchaseOrder({
      PONUM: 'PO-X',
      PURCHASEAGENT: 'USR010',
      PERSON: [{ PERSONID: 'USR011', DISPLAYNAME: 'Otra persona' }],
    });
    expect(other.purchaseAgent).toBe('USR010');
    expect(other.purchaseAgentName).toBeNull();
    const same = toPurchaseOrder({
      PONUM: 'PO-Y',
      PURCHASEAGENT: 'usr010',
      PERSON: [{ PERSONID: 'USR010', DISPLAYNAME: 'Compradora Demo' }],
    });
    expect(same.purchaseAgentName).toBe('Compradora Demo');
  });
});

describe('quién creó la OC (F1, respaldo del comprador)', () => {
  it('es el CHANGEBY del primer estatus del historial (por fecha)', () => {
    const [po100012, po100026] = legacyRecords(
      'ab-compras.legacy-nested.page.json',
      'AB_COMPRAS',
    ).map(toPurchaseOrder);
    // WAPPR 2019-07-01 por USR002, aunque el historial llegue desordenado
    expect(po100012.createdBy).toBe('USR002');
    expect(po100026.purchaseAgent).toBeNull();
    expect(po100026.createdBy).toBe('USR002');
    expect(toPurchaseOrder({ PONUM: 'PO-MIN' }).createdBy).toBeNull();
  });
});

describe('solicitudes de la OC (G2/G3, 2026-09-28)', () => {
  it('prNums = PRNUM distintos de todas las líneas; prIssueDate = la PR más antigua', () => {
    const po = toPurchaseOrder({
      PONUM: 'PO-G2',
      POLINE: [
        {
          POLINENUM: 1,
          PRNUM: 'PR200002',
          PRLINE: [
            {
              PRNUM: 'PR200002',
              PR: [
                { PRNUM: 'PR200002', ISSUEDATE: '2026-03-10T09:00:00+00:00' },
              ],
            },
          ],
        },
        {
          POLINENUM: 2,
          PRNUM: 'PR200001',
          PRLINE: [
            {
              PRNUM: 'PR200001',
              PR: [
                { PRNUM: 'PR200001', ISSUEDATE: '2026-02-01T09:00:00+00:00' },
              ],
            },
          ],
        },
        { POLINENUM: 3, PRNUM: 'PR200002' },
        { POLINENUM: 4 },
      ],
    });
    expect(po.prNums).toEqual(['PR200001', 'PR200002']);
    // La gestión empieza con la primera solicitud (misma regla que SAP D3)
    expect(po.prIssueDate).toBe('2026-02-01T09:00:00+00:00');
    // prnum sigue siendo el de la primera línea con PR (compatibilidad)
    expect(po.prnum).toBe('PR200002');
  });

  it('OC sin solicitud: prNums vacío y prIssueDate null (fuera del promedio)', () => {
    const po = toPurchaseOrder({
      PONUM: 'PO-SIN-PR',
      POLINE: [{ POLINENUM: 1 }],
    });
    expect(po.prNums).toEqual([]);
    expect(po.prIssueDate).toBeNull();
  });

  it('fixtures reales: la PR de la OC con su ISSUEDATE', () => {
    const [po100012] = legacyRecords(
      'ab-compras.legacy-nested.page.json',
      'AB_COMPRAS',
    ).map(toPurchaseOrder);
    expect(po100012.prNums).toEqual(['PR100014']);
    expect(po100012.prIssueDate).toBe('2019-06-25T15:28:46+00:00');
  });
});

describe('recepción de la OC (I1b, 2026-09-30)', () => {
  it('RECEIPTS de la cabecera manda, en cualquier forma de la API', () => {
    expect(
      toPurchaseOrder({ PONUM: 'PO-R1', RECEIPTS: 'complete' }).receiptStatus,
    ).toBe('COMPLETE');
    expect(
      toPurchaseOrder({
        Attributes: {
          PONUM: { content: 'PO-R2' },
          RECEIPTS: { content: 'PARTIAL' },
        },
      }).receiptStatus,
    ).toBe('PARTIAL');
  });

  it('sin RECEIPTS se deriva de POLINE.RECEIPTSCOMPLETE / RECEIVEDQTY', () => {
    const lines = (...l: Record<string, unknown>[]) =>
      toPurchaseOrder({ PONUM: 'PO-R3', POLINE: l }).receiptStatus;
    expect(
      lines(
        { POLINENUM: 1, RECEIPTSCOMPLETE: 1, RECEIVEDQTY: 5 },
        { POLINENUM: 2, RECEIPTSCOMPLETE: true },
      ),
    ).toBe('COMPLETE');
    expect(
      lines(
        { POLINENUM: 1, RECEIPTSCOMPLETE: 0, RECEIVEDQTY: 2 },
        { POLINENUM: 2, RECEIPTSCOMPLETE: 0, RECEIVEDQTY: 0 },
      ),
    ).toBe('PARTIAL');
    expect(
      lines({ POLINENUM: 1, RECEIPTSCOMPLETE: false, RECEIVEDQTY: 0 }),
    ).toBe('NONE');
  });

  it('las capturas reales (anteriores al 2-oct) no traen la recepción: null', () => {
    const all = [
      ...legacyRecords('ab-compras.legacy-nested.page.json', 'AB_COMPRAS'),
      ...legacyRecords('ab-compras.legacy-compact.range.json', 'AB_COMPRAS'),
      ...oslcRecords('ab-compras.oslc.po102249.json'),
    ].map(toPurchaseOrder);
    expect(all.every((po) => po.receiptStatus === null)).toBe(true);
    expect(
      all
        .flatMap((po) => po.lines)
        .every((l) => l.receiptsComplete === null && l.receivedQty === null),
    ).toBe(true);
  });
});

/** Fixture SINTÉTICO de K2/K6: PO104896 con PO5 y LINECOST. */
const PO5_FIXTURE = 'ab-compras.legacy-nested.po5-linecost.SYNTHETIC.json';
const po104896 = (): MaximoPurchaseOrderDto =>
  legacyRecords(PO5_FIXTURE, 'AB_COMPRAS').map(toPurchaseOrder)[0];

describe('estado de integración con SAP (K2, PO5)', () => {
  it('fixture PO104896: INPRG, PROCESADO y recepción COMPLETE', () => {
    const po = po104896();
    expect(po.ponum).toBe('PO104896');
    expect(po.status).toBe('INPRG');
    expect(po.integrationStatus).toBe('PROCESADO');
    expect(po.receiptStatus).toBe('COMPLETE');
    expect(po.currencyCode).toBe('EUR');
  });

  it('PO5 anidado (Attributes.PO5.content), compacto y OSLC: recortado y en mayúsculas', () => {
    const nested = toPurchaseOrder({
      rowstamp: '1',
      Attributes: { PONUM: { content: 'PO-K2A' }, PO5: { content: ' Error ' } },
    });
    expect(nested.integrationStatus).toBe('ERROR');
    expect(
      toPurchaseOrder({ PONUM: 'PO-K2B', PO5: 'actualizar' }).integrationStatus,
    ).toBe('ACTUALIZAR');
    expect(
      toPurchaseOrder({ ponum: 'PO-K2C', po5: 'Agregar', _rowstamp: '2' })
        .integrationStatus,
    ).toBe('AGREGAR');
  });

  it('vacío, en blanco, "~null~" o ausente → null (sin dato)', () => {
    for (const po5 of ['', '   ', '~null~', null]) {
      expect(
        toPurchaseOrder({ PONUM: 'PO-K2D', PO5: po5 }).integrationStatus,
      ).toBeNull();
    }
    expect(
      toPurchaseOrder({
        Attributes: { PONUM: { content: 'PO-K2E' }, PO5: {} },
      }).integrationStatus,
    ).toBeNull();
    expect(toPurchaseOrder({ PONUM: 'PO-K2F' }).integrationStatus).toBeNull();
  });

  it('un literal largo o desconocido se guarda completo y sin interpretar', () => {
    const long = `Falla de interfaz ${'x'.repeat(300)}`;
    const po = toPurchaseOrder({ PONUM: 'PO-K2G', PO5: `  ${long}  ` });
    expect(po.integrationStatus).toBe(long.toUpperCase());
    expect(po.integrationStatus).toHaveLength(long.length);
  });

  it('las capturas reales anteriores al 2-oct no traen PO5: null', () => {
    const all = [
      ...legacyRecords('ab-compras.legacy-nested.page.json', 'AB_COMPRAS'),
      ...legacyRecords('ab-compras.legacy-compact.range.json', 'AB_COMPRAS'),
      ...oslcRecords('ab-compras.oslc.po102249.json'),
    ].map(toPurchaseOrder);
    expect(all.every((po) => po.integrationStatus === null)).toBe(true);
  });
});

describe('subtotal sin IVA de la OC (K6, LINECOST)', () => {
  it('fixture PO104896: subtotal = Σ LINECOST = TOTALCOST (OC exenta)', () => {
    const po = po104896();
    expect(po.lines.map((l) => l.lineCost)).toEqual([1000.1, 499.95, 254.95]);
    expect(po.subtotal).toBe(1755);
    expect(po.totalCost).toBe(1755);
  });

  it('todas las líneas con LINECOST: suma redondeada a 2 decimales (0 cuenta)', () => {
    const po = toPurchaseOrder({
      PONUM: 'PO-K6A',
      POLINE: [
        { POLINENUM: 1, LINECOST: 0.1 },
        { POLINENUM: 2, LINECOST: '0.2' },
        { POLINENUM: 3, LINECOST: 0 },
      ],
    });
    expect(po.subtotal).toBe(0.3);
  });

  it('una línea sin LINECOST → null: no se estima con PRETAXTOTAL ni con TOTALCOST/1.16', () => {
    const po = toPurchaseOrder({
      PONUM: 'PO-K6B',
      PRETAXTOTAL: 100,
      TOTALCOST: 116,
      POLINE: [{ POLINENUM: 1, LINECOST: 60 }, { POLINENUM: 2 }],
    });
    expect(po.lines.map((l) => l.lineCost)).toEqual([60, null]);
    expect(po.subtotal).toBeNull();
    expect(po.pretaxTotal).toBe(100);
  });

  it('OC sin líneas → null aunque traiga TOTALCOST y PRETAXTOTAL', () => {
    const po = toPurchaseOrder({
      PONUM: 'PO-K6C',
      PRETAXTOTAL: 100,
      TOTALCOST: 116,
    });
    expect(po.lines).toEqual([]);
    expect(po.subtotal).toBeNull();
    expect(subtotalOf([])).toBeNull();
  });

  it('las capturas reales sin LINECOST quedan sin subtotal (PO102249 trae PRETAXTOTAL)', () => {
    const [po] = legacyRecords(
      'ab-compras.legacy-compact.po102249.json',
      'AB_COMPRAS',
    ).map(toPurchaseOrder);
    expect(po.pretaxTotal).toBe(368085);
    expect(po.subtotal).toBeNull();
  });
});

describe('líneas de la OC ordenadas por POLINENUM (K3, 2026-10-05)', () => {
  it('fixture PO104896 con líneas 3, 1, 2: prnum, requestedBy y prStatusDate salen de la línea 1', () => {
    const [raw] = legacyRecords(PO5_FIXTURE, 'AB_COMPRAS');
    const arrival = (toCanonical(raw).POLINE as { POLINENUM?: unknown }[]).map(
      (l) => l.POLINENUM,
    );
    expect(arrival).toEqual([3, 1, 2]);

    const po = toPurchaseOrder(raw);
    expect(po.lines.map((l) => l.lineNum)).toEqual([1, 2, 3]);
    // La línea 3 (primera en llegar) es de otra PR y otro solicitante.
    expect(po.lines[2].pr?.prnum).toBe('PR990007');
    expect(po.lines[2].pr?.requestedBy).toBe('USR022');
    expect(po.prnum).toBe('PR990001');
    expect(po.requestedBy).toBe('USR021');
    expect(po.prStatusDate).toBe('2026-09-09T17:20:00+00:00');
    // prNums y la PR más antigua no dependen del orden.
    expect(po.prNums).toEqual(['PR990001', 'PR990007']);
    expect(po.prIssueDate).toBe('2026-09-02T16:20:05+00:00');
    expect(po.lines.map((l) => [l.receiptsComplete, l.receivedQty])).toEqual([
      [true, 1],
      [true, 2],
      [true, 1],
    ]);
    // POSTATUS también llega desordenado.
    expect(po.statusHistory.map((h) => h.status)).toEqual([
      'WAPPR',
      'APPR',
      'INPRG',
    ]);
    expect(po.approvedDate).toBe('2026-09-09T18:05:00+00:00');
    expect(po.createdBy).toBe('USR024');
  });

  it('las líneas sin POLINENUM van al final, en su orden de llegada', () => {
    const po = toPurchaseOrder({
      PONUM: 'PO-K3L',
      POLINE: [
        { PRNUM: 'PR-SIN-A', PRLINE: [{ PR: [{ REQUESTEDBY: 'USR011' }] }] },
        {
          POLINENUM: 2,
          PRNUM: 'PR-2',
          PRLINE: [{ PR: [{ REQUESTEDBY: 'USR012' }] }],
        },
        { PRNUM: 'PR-SIN-B' },
        { POLINENUM: 1 },
      ],
    });
    expect(po.lines.map((l) => [l.lineNum, l.prnum])).toEqual([
      [1, null],
      [2, 'PR-2'],
      [null, 'PR-SIN-A'],
      [null, 'PR-SIN-B'],
    ]);
    // La línea 1 no trae PR: manda la siguiente con PR por número.
    expect(po.prnum).toBe('PR-2');
    expect(po.requestedBy).toBe('USR012');
  });
});

describe('PR de AB_CONTRATOS: estatus, fechas e historial (K3, 2026-10-05)', () => {
  const NESTED = 'ab-contratos.legacy-nested.prstatus.SYNTHETIC.json';
  const COMPACT = 'ab-contratos.legacy-compact.prstatus.SYNTHETIC.json';
  const prDtos = (name: string): MaximoContractDto[] =>
    legacyRecords(name, 'AB_CONTRATOS').flatMap((raw) => toContracts(raw));
  const byPr = (prnum: string): MaximoContractDto => {
    const found = prDtos(NESTED).find((c) => c.prnum === prnum);
    if (!found) throw new Error(`${prnum} no está en ${NESTED}`);
    return found;
  };
  /** Campos de la raíz de la PR (iguales en todas sus revisiones). */
  const prFields = (c: MaximoContractDto) => ({
    prStatus: c.prStatus,
    prTotal: c.prTotal,
    prIssueDate: c.prIssueDate,
    prStatusDate: c.prStatusDate,
    prStatusHistory: c.prStatusHistory,
    prApprovedDate: c.prApprovedDate,
    prApprovedBy: c.prApprovedBy,
    prClosedDate: c.prClosedDate,
    prCancelledDate: c.prCancelledDate,
    prCancelledBy: c.prCancelledBy,
  });

  it('la forma anidada (la que guarda prod) y la compacta dan los mismos DTO', () => {
    const nested = prDtos(NESTED);
    expect(nested).toHaveLength(8); // 7 PR; PR990006 con dos revisiones
    expect(prDtos(COMPACT)).toEqual(nested);
  });

  it('historial desordenado → CHANGEDATE ascendente; en el mismo segundo desempata PRSTATUSID', () => {
    const c = byPr('PR990001');
    expect(c.prStatusHistory.map((h) => [h.status, h.changedBy])).toEqual([
      ['WAPPR', 'USR021'],
      ['APPR', 'USR023'],
      ['CLOSE', 'USR024'],
    ]);
    expect(c.prStatusHistory[0].changeDate).toBe(
      c.prStatusHistory[1].changeDate,
    );
    expect(c.prStatus).toBe('CLOSE');
    expect(c.prTotal).toBe(1500.05);
    expect(c.prIssueDate).toBe('2026-09-02T16:20:05+00:00');
    expect(c.prStatusDate).toBe('2026-09-09T17:20:00+00:00');
    expect(c.prApprovedDate).toBe('2026-09-02T16:20:05+00:00');
    expect(c.prApprovedBy).toBe('USR023');
    expect(c.prClosedDate).toBe('2026-09-09T17:20:00+00:00');
    expect(c.prCancelledDate).toBeNull();
    expect(c.prCancelledBy).toBeNull();
    // status y createdDate no cambian de regla: sin contrato, el de la PR.
    expect(c.hasContract).toBe(false);
    expect(c.status).toBe('CLOSE');
    expect(c.createdDate).toBeNull();
  });

  it('el desempate por PRSTATUSID no depende del orden de llegada', () => {
    const rows = [
      {
        STATUS: 'APPR',
        CHANGEDATE: '2026-05-01T12:00:00+00:00',
        PRSTATUSID: 20,
      },
      {
        STATUS: 'WAPPR',
        CHANGEDATE: '2026-05-01T12:00:00+00:00',
        PRSTATUSID: 10,
      },
    ];
    for (const PRSTATUS of [rows, [...rows].reverse()]) {
      const c = toContract({ PRNUM: 'PR-K3-TIE', PRSTATUS });
      expect(c.prStatusHistory.map((h) => h.status)).toEqual(['WAPPR', 'APPR']);
    }
  });

  it('APPR → WAPPR → APPR: la llegada a Compras es la PRIMERA APPR', () => {
    const c = byPr('PR990002');
    expect(c.prStatusHistory.map((h) => h.status)).toEqual([
      'WAPPR',
      'APPR',
      'WAPPR',
      'APPR',
    ]);
    expect(c.prStatus).toBe('APPR');
    expect(c.prStatusDate).toBe('2026-09-18T13:15:00+00:00');
    expect(c.prApprovedDate).toBe('2026-09-15T09:00:00+00:00');
    expect(c.prApprovedBy).toBe('USR023');
    expect(c.prClosedDate).toBeNull();
    expect(c.prCancelledDate).toBeNull();
    expect(c.prStatusHistory[2].memo).toBe(
      'Comentario de prueba: regresa a aprobación',
    );
  });

  it('CAN con MEMO: fecha y usuario de la cancelación, y la nota en su cambio', () => {
    const c = byPr('PR990003');
    expect(c.prStatus).toBe('CAN');
    expect(c.prStatusHistory.map((h) => [h.status, h.memo])).toEqual([
      ['WAPPR', null],
      ['APPR', null],
      ['CAN', 'Comentario de prueba: cancelada por duplicado'],
    ]);
    expect(c.prCancelledDate).toBe('2026-08-28T16:40:00+00:00');
    expect(c.prCancelledBy).toBe('USR024');
    expect(c.prApprovedDate).toBe('2026-08-21T09:10:00+00:00');
  });

  it('STATUS CAN sin fila CAN → prCancelledDate null (sin respaldo por STATUSDATE) y sin APPR inferida', () => {
    const c = byPr('PR990004');
    expect(c.prStatus).toBe('CAN');
    expect(c.prStatusDate).toBe('2026-07-15T10:00:00+00:00');
    expect(c.prStatusHistory.map((h) => h.status)).toEqual(['WAPPR']);
    expect(c.prCancelledDate).toBeNull();
    expect(c.prCancelledBy).toBeNull();
    expect(c.prApprovedDate).toBeNull();
    expect(c.prApprovedBy).toBeNull();
  });

  it('PR en WAPPR: en aprobación, todavía sin llegada a Compras', () => {
    const c = byPr('PR990005');
    expect(c.prStatus).toBe('WAPPR');
    expect(c.prIssueDate).toBe('2026-09-29T15:30:00+00:00');
    expect(c.prApprovedDate).toBeNull();
  });

  it('contrato en APPR con la PR en CLOSE: los campos de la PR se repiten en cada revisión', () => {
    const revs = prDtos(NESTED).filter((c) => c.prnum === 'PR990006');
    expect(revs.map((c) => [c.revisionNum, c.status])).toEqual([
      [0, 'REVISD'],
      [1, 'APPR'],
    ]);
    for (const c of revs) {
      expect(c.hasContract).toBe(true);
      expect(c.contractNum).toBe('9906');
      expect(c.prStatus).toBe('CLOSE');
      expect(c.prApprovedDate).toBe('2026-06-11T09:00:00+00:00');
      expect(c.prClosedDate).toBe('2026-06-15T12:00:00+00:00');
      // created_at_source sigue siendo la WAPPR del CONTRATO (aquí no hay).
      expect(c.createdDate).toBeNull();
    }
    expect(prFields(revs[0])).toEqual(prFields(revs[1]));
  });

  it('último CLOSE y última CAN por fecha; las filas sin CHANGEDATE o sin STATUS no cuentan', () => {
    const c = toContract({
      PRNUM: 'PR-K3-LAST',
      STATUS: 'CAN',
      PRSTATUS: [
        {
          STATUS: 'CAN',
          CHANGEDATE: '2026-03-05T10:00:00+00:00',
          CHANGEBY: 'USR042',
          PRSTATUSID: 6,
        },
        {
          STATUS: 'CLOSE',
          CHANGEDATE: '2026-02-01T10:00:00+00:00',
          CHANGEBY: 'USR041',
          PRSTATUSID: 3,
        },
        {
          STATUS: 'APPR',
          CHANGEDATE: '2026-01-10T10:00:00+00:00',
          CHANGEBY: 'USR040',
          PRSTATUSID: 2,
        },
        {
          STATUS: 'CAN',
          CHANGEDATE: '2026-03-01T10:00:00+00:00',
          CHANGEBY: 'USR043',
          PRSTATUSID: 5,
        },
        {
          STATUS: 'CLOSE',
          CHANGEDATE: '2026-02-20T10:00:00+00:00',
          CHANGEBY: 'USR044',
          PRSTATUSID: 4,
        },
        { STATUS: 'CAN', CHANGEBY: 'USR045', PRSTATUSID: 7 },
        {
          STATUS: 'WAPPR',
          CHANGEDATE: '2026-01-05T10:00:00+00:00',
          PRSTATUSID: 1,
          MEMO: '  ',
        },
        { CHANGEDATE: '2026-01-06T10:00:00+00:00', PRSTATUSID: 9 },
      ],
    });
    expect(c.prStatusHistory.map((h) => h.status)).toEqual([
      'WAPPR',
      'APPR',
      'CLOSE',
      'CLOSE',
      'CAN',
      'CAN',
      'CAN',
    ]);
    expect(c.prStatusHistory[0].memo).toBeNull(); // MEMO en blanco
    expect(c.prApprovedDate).toBe('2026-01-10T10:00:00+00:00');
    expect(c.prApprovedBy).toBe('USR040');
    expect(c.prClosedDate).toBe('2026-02-20T10:00:00+00:00');
    expect(c.prCancelledDate).toBe('2026-03-05T10:00:00+00:00');
    expect(c.prCancelledBy).toBe('USR042');
  });

  it('PRSTATUS ya no es respaldo del estatus de la PR: es el historial', () => {
    const c = toContract({
      PRNUM: 'PR-K3-H',
      PRSTATUS: [
        {
          STATUS: 'APPR',
          CHANGEDATE: '2026-04-01T10:00:00+00:00',
          PRSTATUSID: 1,
        },
      ],
    });
    expect(c.prStatus).toBeNull();
    expect(c.status).toBeNull();
    expect(c.prApprovedDate).toBe('2026-04-01T10:00:00+00:00');
  });

  it('capturas anteriores al 2-oct y raíz PURCHVIEW: campos de la PR null e historial vacío', () => {
    const old = [
      ...legacyRecords(
        'ab-contratos.legacy-compact.pr102828.json',
        'AB_CONTRATOS',
      ),
      ...legacyRecords(
        'ab-contratos.legacy-nested.no-contract.json',
        'AB_CONTRATOS',
      ),
      ...legacyRecords(
        'ab-contratos.legacy-compact.purchview-root.v1.json',
        'AB_CONTRATOS',
      ),
    ].flatMap((raw) => toContracts(raw));
    for (const c of old) {
      expect(prFields(c)).toEqual({
        prStatus: null,
        prTotal: null,
        prIssueDate: null,
        prStatusDate: null,
        prStatusHistory: [],
        prApprovedDate: null,
        prApprovedBy: null,
        prClosedDate: null,
        prCancelledDate: null,
        prCancelledBy: null,
      });
    }
  });

  it('smoke de K4: en TODOS los fixtures hay exactamente una PR APPR sin contrato ni OC y una WAPPR', () => {
    const files = readdirSync(join(__dirname, '__fixtures__')).filter((f) =>
      f.endsWith('.json'),
    );
    const recordsOf = (prefix: string, os: 'AB_COMPRAS' | 'AB_CONTRATOS') =>
      files
        .filter((f) => f.startsWith(prefix) && !f.startsWith('oslc.error'))
        .flatMap((f) =>
          f.includes('.oslc.') ? oslcRecords(f) : legacyRecords(f, os),
        );
    const prsWithPo = new Set(
      recordsOf('ab-compras.', 'AB_COMPRAS')
        .map(toPurchaseOrder)
        .flatMap((po) => po.prNums),
    );
    const prs = recordsOf('ab-contratos.', 'AB_CONTRATOS').flatMap((raw) =>
      toContracts(raw),
    );
    const deContrato = new Set(
      prs.filter((c) => c.hasContract).map((c) => c.prnum),
    );
    const distinct = (list: MaximoContractDto[]) => [
      ...new Set(list.map((c) => c.prnum)),
    ];

    expect(
      distinct(
        prs.filter(
          (c) =>
            c.prStatus === 'APPR' &&
            !deContrato.has(c.prnum) &&
            !prsWithPo.has(c.prnum ?? ''),
        ),
      ),
    ).toEqual(['PR990002']);
    expect(distinct(prs.filter((c) => c.prStatus === 'WAPPR'))).toEqual([
      'PR990005',
    ]);
    // La PR de contrato APPR con la PR en CLOSE no es pendiente de nada.
    expect(deContrato.has('PR990006')).toBe(true);
    expect(byPr('PR990006').prStatus).toBe('CLOSE');
  });
});

describe('comprador de la RQ, tipo de cambio y contrato (O, 2026-10-26)', () => {
  const rqPos = () =>
    new Map(
      legacyRecords(RQ_FIXTURE, 'AB_COMPRAS')
        .map(toPurchaseOrder)
        .map((po) => [po.ponum, po]),
    );

  /** La forma OSLC del mismo registro: claves en minúsculas y `_rowstamp`. */
  function toOslc(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(toOslc);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k === 'ROWSTAMP' ? '_rowstamp' : k.toLowerCase(),
        toOslc(v),
      ]),
    );
  }

  it('el comprador es la fila de RFQSTATUS con el RFQSTATUSSEQ más alto, con su nombre', () => {
    const po = rqPos().get('PO990101')!;
    expect(po.rfqBuyer).toEqual({
      rfqNum: 'RQ990101',
      changedBy: 'USR041',
      displayName: 'Persona Demo 41',
      seq: 52164,
    });
    expect(po.rfqNums).toEqual(['RQ990101']);
    // "Capturó" sigue siendo quien creó la OC (dato del documento)
    expect(po.createdBy).toBe('USR031');
    expect(po.exchangeRate).toBe(0.0580848);
    expect(po.contractRefNum).toBeNull();
  });

  it('RFQSTATUS debajo de la línea también cuenta; si su PERSON es otra persona, sin nombre', () => {
    const po = rqPos().get('PO990102')!;
    expect(po.rfqBuyer).toEqual({
      rfqNum: 'RQ990102',
      changedBy: 'USR043',
      displayName: null,
      seq: 52200,
    });
    expect(po.currencyCode).toBe('USD');
    expect(po.exchangeRate).toBe(1);
  });

  it('RFQSTATUS debajo de RFQLINE (donde lo manda CIISA en prod) también cuenta', () => {
    const po = rqPos().get('PO990106')!;
    // dos líneas de la misma RQ: gana la fila con el RFQSTATUSSEQ más alto
    expect(po.rfqBuyer).toEqual({
      rfqNum: 'RQ990106',
      changedBy: 'USR045',
      displayName: 'Persona Demo 45',
      seq: 52300,
    });
    expect(po.rfqNums).toEqual(['RQ990106']);
    expect(po.contractRefNum).toBeNull();
    expect(po.exchangeRate).toBe(0.0586761);
  });

  it('con RFQSTATUS en varios niveles gana el RFQSTATUSSEQ más alto; empate completo, la cabecera, luego las líneas y al final las líneas de RQ', () => {
    const row = (changeby: string, seq: number, rfqnum: string) => ({
      CHANGEBY: changeby,
      RFQSTATUSSEQ: seq,
      RFQNUM: rfqnum,
    });
    const po = (extra: Record<string, unknown>) =>
      toPurchaseOrder({ PONUM: 'PO-N', ...extra });
    expect(
      po({
        RFQSTATUS: [row('USR001', 5, 'RQA')],
        RFQLINE: [{ RFQSTATUS: [row('USR002', 9, 'RQB')] }],
      }).rfqBuyer?.changedBy,
    ).toBe('USR002');
    expect(
      po({
        RFQLINE: [{ RFQSTATUS: [row('USR001', 5, 'RQB')] }],
        POLINE: [{ RFQSTATUS: [row('USR001', 5, 'RQA')] }],
      }).rfqBuyer?.rfqNum,
    ).toBe('RQA');
    const dosLineas = po({
      RFQLINE: [
        { RFQSTATUS: [row('USR001', 5, 'RQC')] },
        { RFQSTATUS: [row('USR001', 5, 'RQB')] },
      ],
    });
    expect(dosLineas.rfqBuyer?.rfqNum).toBe('RQC');
    expect(dosLineas.rfqNums).toEqual(['RQB', 'RQC']);
  });

  it('OC de contrato = CONTRACTREFNUM con valor en la cabecera o en una línea', () => {
    const pos = rqPos();
    expect(pos.get('PO990103')!.contractRefNum).toBe('1035');
    expect(pos.get('PO990103')!.rfqBuyer).toBeNull();
    expect(pos.get('PO990105')!.contractRefNum).toBe('1040');
    // vacío en la cabecera y "~null~" en la línea: no es de contrato
    const eur = pos.get('PO990104')!;
    expect(eur.contractRefNum).toBeNull();
    expect(eur.rfqBuyer).toBeNull();
    expect(eur.rfqNums).toEqual([]);
    expect(eur.exchangeRate).toBe(1.19);
  });

  it('las tres formas (anidado, compacto y OSLC) dan el mismo DTO', () => {
    for (const raw of legacyRecords(RQ_FIXTURE, 'AB_COMPRAS')) {
      const nested = toPurchaseOrder(raw);
      const compact = canonicalize(raw);
      expect(toPurchaseOrder(compact)).toEqual(nested);
      expect(toPurchaseOrder(toOslc(compact))).toEqual(nested);
    }
  });

  it('filas sin CHANGEBY no cuentan; sin RFQSTATUSSEQ van al final; empate, el usuario menor', () => {
    const base = { PONUM: 'PO-RQ' };
    const row = (changeby: string | null, seq: number | null) => ({
      RFQNUM: 'RQ1',
      CHANGEBY: changeby,
      RFQSTATUSSEQ: seq,
    });
    expect(
      toPurchaseOrder({
        ...base,
        RFQSTATUS: [row(null, 99), row('USR002', null), row('USR001', 5)],
      }).rfqBuyer?.changedBy,
    ).toBe('USR001');
    expect(
      toPurchaseOrder({
        ...base,
        RFQSTATUS: [row('USR009', 7), row('USR003', 7)],
      }).rfqBuyer?.changedBy,
    ).toBe('USR003');
    expect(
      toPurchaseOrder({ ...base, RFQSTATUS: [row('USR004', null)] }).rfqBuyer,
    ).toEqual({
      rfqNum: 'RQ1',
      changedBy: 'USR004',
      displayName: null,
      seq: null,
    });
    const sinRq = toPurchaseOrder({ ...base, RFQSTATUS: [row(' ', 3)] });
    expect(sinRq.rfqBuyer).toBeNull();
    expect(sinRq.rfqNums).toEqual(['RQ1']);
  });

  it('casos borde, igual que el SQL: espacios ASCII, " ~null~ ", números, la primera PERSON que es objeto y el empate por orden', () => {
    const po = (extra: Record<string, unknown>) =>
      toPurchaseOrder({ PONUM: 'PO-B', ...extra });
    expect(
      po({ CONTRACTREFNUM: '\t', POLINE: [{ CONTRACTREFNUM: ' ~null~ ' }] })
        .contractRefNum,
    ).toBeNull();
    expect(po({ EXCHANGERATE: ' 17.5 ' }).exchangeRate).toBe(17.5);
    expect(po({ EXCHANGERATE: '0x10' }).exchangeRate).toBeNull();
    expect(
      po({
        RFQSTATUS: [
          { CHANGEBY: '\t', RFQSTATUSSEQ: 9 },
          { CHANGEBY: 'USR007', RFQSTATUSSEQ: '0x10' },
        ],
      }).rfqBuyer,
    ).toEqual({
      rfqNum: null,
      changedBy: 'USR007',
      displayName: null,
      seq: null,
    });
    expect(
      po({
        RFQSTATUS: [
          {
            CHANGEBY: 'USR008',
            PERSON: [
              'x',
              { PERSONID: 'USR008', DISPLAYNAME: 'Persona Demo 8' },
            ],
          },
        ],
      }).rfqBuyer?.displayName,
    ).toBe('Persona Demo 8');
    // empate completo (mismo usuario y número): gana la primera que llega
    expect(
      po({
        RFQSTATUS: [
          { CHANGEBY: 'USR001', RFQSTATUSSEQ: 5, RFQNUM: 'RQA' },
          { CHANGEBY: 'USR001', RFQSTATUSSEQ: 5, RFQNUM: 'RQB' },
        ],
      }).rfqBuyer?.rfqNum,
    ).toBe('RQA');
  });
});

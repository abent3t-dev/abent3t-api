import {
  buildVendorXref,
  effectiveMaximoVendor,
  maximoVendorNote,
  MigratedPair,
  normalizeCompanyName,
  vendorMismatchRows,
  vendorMismatchSummary,
} from './maximo-vendor-xref';

/**
 * G1 (2026-09-28). Fixture del diagnóstico en prod: en Maximo P0000440 se
 * llama "ASOCIACION MEXICANA DE ENERGIA", pero sus OC migradas a SAP quedaron
 * a nombre de P0000219 NAES ENERGIA S DE RL DE CV.
 */

const pair = (
  ponum: string,
  vendor_id: string | null,
  vendor_name: string | null,
  card_code: string,
  card_name: string | null,
): MigratedPair => ({ ponum, vendor_id, vendor_name, card_code, card_name });

const ASOCIACION = 'ASOCIACION MEXICANA DE ENERGIA';
const NAES = 'NAES ENERGIA S DE RL DE CV';

function prodLikeXref() {
  const pairs: MigratedPair[] = [
    // P0000440 → NAES en 10 de 10 OC migradas (en SAP con dos nombres)
    ...Array.from({ length: 9 }, (_, i) =>
      pair(`PO1040${i}`, 'P0000440', ASOCIACION, 'P0000219', NAES),
    ),
    pair('PO104099', 'P0000440', ASOCIACION, 'P0000219', 'NAES ENERGIA'),
    // P0000544 "GRUPO DEVAN" → Galiper
    pair(
      'PO200001',
      'P0000544',
      'GRUPO DEVAN S A P I DE CV',
      'P0000323',
      'GALIPER INDUSTRIAL SA DE CV',
    ),
    pair(
      'PO200002',
      'P0000544',
      'GRUPO DEVAN S A P I DE CV',
      'P0000323',
      'GALIPER INDUSTRIAL',
    ),
    // Mismo proveedor con otra forma jurídica: NO es nombre distinto
    pair(
      'PO300001',
      'P0000777',
      'ABB MEXICO S.A. DE C.V.',
      'P0000888',
      'ABB MEXICO SA DE CV',
    ),
    pair(
      'PO300002',
      'P0000777',
      'ABB MEXICO S.A. DE C.V.',
      'P0000888',
      'ABB MEXICO SA DE CV',
    ),
    // Ambiguo: 1 y 1 (50%)
    pair(
      'PO400001',
      'P0000900',
      'SERVICIOS X',
      'P0000901',
      'SERVICIOS X SA DE CV',
    ),
    pair(
      'PO400002',
      'P0000900',
      'SERVICIOS X',
      'P0000902',
      'OTRA EMPRESA SA DE CV',
    ),
    // Una sola OC migrada con otro nombre: no alcanza para el cruce (b)
    pair(
      'PO500001',
      'P0000950',
      'NOMBRE COPIADO',
      'P0000951',
      'EMPRESA REAL SA DE CV',
    ),
  ];
  const bpNames = new Map([['P0000219', NAES]]);
  return buildVendorXref(pairs, bpNames);
}

describe('proveedor efectivo de Maximo (G1)', () => {
  const xref = prodLikeXref();

  it('(a) la OC migrada toma el proveedor de SU OC en SAP (nombre del maestro de SAP)', () => {
    const v = effectiveMaximoVendor(
      { ponum: 'PO104099', vendor_id: 'P0000440', vendor_name: ASOCIACION },
      xref,
    );
    expect(v).toMatchObject({
      key: 'sap:P0000219',
      code: 'P0000219',
      // la OC en SAP dice "NAES ENERGIA"; el maestro, el nombre completo
      name: NAES,
      source: 'sap_oc',
      maximo_code: 'P0000440',
      maximo_name: ASOCIACION,
      differs: true,
    });
    expect(maximoVendorNote(v)).toBe(`en Maximo: ${ASOCIACION} (P0000440)`);
  });

  it('(b) la OC aún no migrada toma el cruce dominante (≥90%, mínimo 2) con el nombre del maestro de SAP', () => {
    const v = effectiveMaximoVendor(
      { ponum: 'PO104851', vendor_id: 'P0000440', vendor_name: ASOCIACION },
      xref,
    );
    expect(v).toMatchObject({
      key: 'sap:P0000219',
      name: NAES,
      source: 'sap_cruce',
      differs: true,
    });
    const entry = xref.byVendor.get('P0000440')!;
    expect(entry.migrated).toBe(10);
    expect(entry.dominant?.share).toBe(1);
  });

  it('(c) sin cruce confiable se queda lo de Maximo', () => {
    // ambiguo (50/50) y una sola OC: no hay dominante
    expect(
      effectiveMaximoVendor(
        { ponum: 'X1', vendor_id: 'P0000900', vendor_name: 'SERVICIOS X' },
        xref,
      ),
    ).toMatchObject({
      key: 'maximo:P0000900',
      source: 'maximo',
      differs: false,
    });
    expect(
      effectiveMaximoVendor(
        { ponum: 'X2', vendor_id: 'P0000950', vendor_name: 'NOMBRE COPIADO' },
        xref,
      ),
    ).toMatchObject({
      key: 'maximo:P0000950',
      name: 'NOMBRE COPIADO',
      source: 'maximo',
    });
    // proveedor sin OC migradas
    expect(
      effectiveMaximoVendor(
        { vendor_id: 'P0001234', vendor_name: 'LOCAL SA' },
        xref,
      ),
    ).toMatchObject({
      key: 'maximo:P0001234',
      code: 'P0001234',
      source: 'maximo',
    });
    expect(
      effectiveMaximoVendor({ vendor_id: null, vendor_name: null }, xref).key,
    ).toBeNull();
  });

  it('las llaves separan los maestros: P0000219 de Maximo no es P0000219 de SAP', () => {
    const v = effectiveMaximoVendor(
      { vendor_id: 'P0000219', vendor_name: 'OTRO' },
      xref,
    );
    expect(v.key).toBe('maximo:P0000219');
  });

  it('misma empresa con otra forma jurídica no cuenta como nombre distinto', () => {
    expect(normalizeCompanyName('GALIPER INDUSTRIAL SA DE CV')).toBe(
      'GALIPER INDUSTRIAL',
    );
    expect(normalizeCompanyName('Grupo Devan S.A.P.I. de C.V.')).toBe(
      'GRUPO DEVAN',
    );
    expect(normalizeCompanyName('NAES ENERGIA S DE RL DE CV')).toBe(
      'NAES ENERGIA',
    );
    expect(normalizeCompanyName('Energía')).toBe('ENERGIA');
    const v = effectiveMaximoVendor(
      { vendor_id: 'P0000777', vendor_name: 'ABB MEXICO S.A. DE C.V.' },
      xref,
    );
    expect(v.source).toBe('sap_cruce');
    expect(v.differs).toBe(false);
    expect(maximoVendorNote(v)).toBeNull();
  });
});

describe('lista de nombres distintos Maximo vs SAP (G1.3)', () => {
  const xref = prodLikeXref();

  it('muestra el par ASOCIACION (P0000440) → NAES (P0000219), los ambiguos y los de una sola OC', () => {
    const rows = vendorMismatchRows(xref);
    expect(rows[0]).toMatchObject({
      kind: 'nombre_distinto',
      maximo_code: 'P0000440',
      maximo_name: ASOCIACION,
      sap_code: 'P0000219',
      sap_name: NAES,
      migrated: 10,
      migrated_total: 10,
      coverage_pct: 100,
    });
    expect(rows.find((r) => r.maximo_code === 'P0000544')).toMatchObject({
      kind: 'nombre_distinto',
      sap_code: 'P0000323',
    });
    // ABB: misma empresa → fuera de la lista
    expect(rows.some((r) => r.maximo_code === 'P0000777')).toBe(false);
    // Ambiguo: una fila por proveedor de SAP, con su cobertura
    expect(
      rows
        .filter((r) => r.maximo_code === 'P0000900')
        .map((r) => [r.kind, r.sap_code, r.coverage_pct]),
    ).toEqual([
      ['ambiguo', 'P0000901', 50],
      ['ambiguo', 'P0000902', 50],
    ]);
    expect(rows.find((r) => r.maximo_code === 'P0000950')?.kind).toBe('una_oc');
  });

  it('resumen para la Bitácora: códigos con nombre distinto y ambiguos', () => {
    expect(vendorMismatchSummary(xref)).toEqual({
      codigos_con_migradas: 5,
      nombre_distinto: 2,
      ambiguos: 1,
      una_oc: 1,
    });
  });
});

describe('regla (a) sin el proveedor en el maestro de SAP', () => {
  it('usa el nombre de la OC en SAP', () => {
    const xref = buildVendorXref(
      [pair('PO1', 'P0000440', ASOCIACION, 'P0000999', 'NOMBRE EN LA OC')],
      new Map(),
    );
    expect(
      effectiveMaximoVendor(
        { ponum: 'PO1', vendor_id: 'P0000440', vendor_name: ASOCIACION },
        xref,
      ).name,
    ).toBe('NOMBRE EN LA OC');
  });
});

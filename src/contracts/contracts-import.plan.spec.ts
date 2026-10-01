import {
  compact,
  type ExistingContract,
  matchSupplier,
  normalizeContractRows,
  parseAmount,
  parseCurrency,
  parseExcelDate,
  pickContractSheet,
  planContractImport,
  readExcelDate,
} from './contracts-import.plan';

/**
 * H2 (2026-09-29) — importación de la base de contratos depurada de Diana:
 * columnas del Excel, altas, cambios campo por campo sin pisar con vacíos,
 * sin cambios y faltantes (candidatos a baja).
 */

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const TODAY = D('2026-09-30');

const suppliers = [
  { id: 'sup-uvx', legal_name: 'Uvx, S.A.P.I. De C.V.' },
  { id: 'sup-technip', legal_name: 'Technip Energies Usa Inc' },
  { id: 'sup-honey-1', legal_name: 'Honeywell Mexico SA' },
  { id: 'sup-honey-2', legal_name: 'Honeywell Mexico SA' },
].map((s) => ({ ...s, key: compact(s.legal_name) }));

const existing = (overrides: Partial<ExistingContract>): ExistingContract => ({
  id: 'c-1',
  contract_number: '7400016518',
  tomo: null,
  document_type: 'contrato',
  service_description: 'MIG DOCUMENTOS - HK - 2023 - TECHNIP ENE',
  supplier_id: 'sup-technip',
  supplier_name: 'Technip Energies Usa Inc',
  start_date: D('2023-11-15'),
  end_date: D('2024-11-15'),
  total_amount: null,
  currency: null,
  consumed_amount: null,
  external_link: null,
  responsible_user_name: 'Carmina Ivonne Sanchez',
  responsible_user_email: null,
  status: 'vencido',
  notes:
    'Importado del Excel CONTROL_DE_CONTRATOS (2026-09-21). Fecha real de fin (Excel): 2024-11-15. Adm. de contrato: Mendez Perez Diana. Documento (SharePoint): 7400016518.',
  created_by: null,
  carpeta: null,
  document_label: null,
  user_area: null,
  buyer_profile_id: null,
  ...overrides,
});

/** Fila con el formato del 21-sep (el "Adm. de  Contrato" trae doble espacio). */
const record = (overrides: Record<string, unknown> = {}) => ({
  '#': 3,
  Contrato: 7400016518,
  Proveedor: 'Technip Energies Usa Inc',
  'Descrip.': 'MIG DOCUMENTOS - HK - 2023 - TECHNIP ENE',
  'Fecha Inicio': new Date('2023-11-15T06:00:36.000Z'),
  'Fecha Fin': new Date('2024-11-15T06:00:36.000Z'),
  'Fecha real': new Date('2024-11-15T06:00:36.000Z'),
  'Resp. Usuario': 'Carmina Ivonne Sanchez',
  'Disp.': 1,
  'Adm. de  Contrato': 'Mendez Perez Diana',
  Documento: 7400016518,
  ...overrides,
});

const plan = (
  records: Array<Record<string, unknown>>,
  current: ExistingContract[],
  update = true,
  defaultCurrency: string | null = null,
) =>
  planContractImport({
    rows: normalizeContractRows(records).rows,
    existing: current,
    suppliers,
    options: { today: TODAY, update, defaultCurrency },
  });

describe('columnas del Excel', () => {
  it('lee el formato del 21-sep; ignora filas vacías y el "% disponible"', () => {
    const { rows } = normalizeContractRows([record(), { '#': 4 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      number: '7400016518',
      responsible: 'Carmina Ivonne Sanchez',
      admin: 'Mendez Perez Diana',
      documentRef: '7400016518',
      amount: null,
      consumed: null,
    });
  });

  it('montos, monedas y link de la base nueva', () => {
    expect(parseAmount('$1,234.50')).toBe(1234.5);
    expect(parseAmount('35%')).toBeNull();
    expect(parseCurrency('Pesos')).toBe('MXN');
    expect(parseCurrency('dls')).toBe('USD');
    const { rows, warnings } = normalizeContractRows([
      record({ Monto: '$1,000.00', Moneda: 'MN', Link: 'carpeta sin url' }),
    ]);
    expect(rows[0]).toMatchObject({
      amount: 1000,
      currency: 'MXN',
      link: null,
    });
    expect(warnings[0]).toContain('no es una URL');
  });
});

describe('altas', () => {
  it('nuevo contrato con proveedor del catálogo o alta manual (una por proveedor)', () => {
    const p = plan(
      [
        record({ Contrato: 7400099001, 'Fecha Fin': D('2027-01-31') }),
        record({ Contrato: 7400099002, Proveedor: 'Baker Hughes de Mexico' }),
        record({ Contrato: 7400099003, Proveedor: 'Baker Hughes de Mexico' }),
      ],
      [],
    );
    expect(
      p.create.map((c) => [c.data.contract_number, c.data.status]),
    ).toEqual([
      ['7400099001', 'vigente'],
      ['7400099002', 'vencido'],
      ['7400099003', 'vencido'],
    ]);
    expect(p.create[0].data.supplier_id).toBe('sup-technip');
    expect(p.create[1].data).toMatchObject({
      supplier_id: undefined,
      new_supplier_name: 'Baker Hughes de Mexico',
    });
    expect(p.create[2].supplierNote).toContain('ALTA manual');
    // sin monto no hay moneda (nunca el MXN por default de la columna)
    expect(p.create[0].data).toMatchObject({
      total_amount: null,
      currency: null,
    });
  });

  it('proveedor ambiguo o contrato repetido → error y la fila no se toca; sin fecha de fin sí se importa (I6)', () => {
    const p = plan(
      [
        record({ Contrato: 1, Proveedor: 'Honeywell Mexico SA' }),
        record({ Contrato: 2, 'Fecha Fin': null }),
        record({ Contrato: 3 }),
        record({ Contrato: 3 }),
      ],
      [],
    );
    expect(p.errors).toHaveLength(2);
    expect(p.create.map((c) => c.data.contract_number)).toEqual(['2', '3']);
    expect(p.create[0].data).toMatchObject({
      end_date: null,
      status: 'vigente',
    });
    expect(p.report.noEndDate).toEqual(['2']);
  });

  it('sin --update, los que ya existen se saltan (como antes)', () => {
    const p = plan([record()], [existing({})], false);
    expect(p.skipped).toEqual(['7400016518']);
    expect(p.update).toEqual([]);
    expect(p.missing).toEqual([]);
  });
});

describe('--update: cambios campo por campo', () => {
  it('el responsable corregido por Diana (Carmina) se actualiza', () => {
    const p = plan(
      [record({ 'Resp. Usuario': 'Julio César Rodríguez' })],
      [existing({})],
    );
    expect(p.update).toHaveLength(1);
    expect(p.update[0].changes).toEqual([
      {
        field: 'responsible_user_name',
        from: 'Carmina Ivonne Sanchez',
        to: 'Julio César Rodríguez',
      },
    ]);
    expect(p.update[0].data).toEqual({
      responsible_user_name: 'Julio César Rodríguez',
    });
  });

  it('una celda vacía nunca pisa lo capturado en la UI (link, consumido, monto)', () => {
    const captured = existing({
      total_amount: 500000,
      currency: 'USD',
      consumed_amount: 120000,
      external_link: 'https://abent3t.sharepoint.com/contratos/7400016518.pdf',
    });
    const p = plan([record({ 'Resp. Usuario': null })], [captured]);
    expect(p.update).toEqual([]);
    expect(p.unchanged).toEqual(['7400016518']);
  });

  it('si el archivo sí trae valor, lo actualiza; la moneda cambia solo con un monto', () => {
    const p = plan(
      [record({ Monto: 750000, Moneda: 'USD', Consumido: '$120,000.00' })],
      [
        existing({
          total_amount: 500000,
          currency: 'USD',
          consumed_amount: 120000,
        }),
      ],
    );
    expect(p.update[0].changes).toEqual([
      { field: 'total_amount', from: '500000.00', to: '750000.00' },
    ]);
  });

  it('monto sin moneda: no se importa, salvo --moneda explícito', () => {
    const noCurrency = plan([record({ Monto: 1000 })], [existing({})]);
    expect(noCurrency.update).toEqual([]);
    expect(noCurrency.warnings[0]).toContain('sin moneda');
    const withDefault = plan(
      [record({ Monto: 1000 })],
      [existing({})],
      true,
      'MXN',
    );
    expect(withDefault.update[0].changes.map((c) => c.field)).toEqual([
      'total_amount',
      'currency',
    ]);
  });

  it('fin nuevo recalcula el estatus; las notas no se reescriben, se agrega lo nuevo', () => {
    const p = plan(
      [
        record({
          'Fecha Fin': new Date('2027-06-30T06:00:36.000Z'),
          'Adm. de  Contrato': 'Ingrid Torres',
        }),
      ],
      [existing({})],
    );
    const changes = new Map(p.update[0].changes.map((c) => [c.field, c]));
    expect(changes.get('end_date')).toMatchObject({
      from: '2024-11-15',
      to: '2027-06-30',
    });
    expect(changes.get('status')).toMatchObject({
      from: 'vencido',
      to: 'vigente',
    });
    const notes = p.update[0].data.notes ?? '';
    expect(notes.startsWith(existing({}).notes ?? '')).toBe(true);
    expect(notes).toContain(
      'Actualización del Excel (2026-09-30): Adm. de contrato: Ingrid Torres.',
    );
  });

  it('cambio de proveedor al del catálogo', () => {
    const p = plan([record({ Proveedor: 'UVX SAPI DE CV' })], [existing({})]);
    expect(p.update[0].changes).toEqual([
      {
        field: 'supplier',
        from: 'Technip Energies Usa Inc',
        to: 'Uvx, S.A.P.I. De C.V.',
      },
    ]);
    expect(p.update[0].data.supplier_id).toBe('sup-uvx');
  });
});

describe('--update: faltantes (candidatos a baja)', () => {
  it('los que ya no vienen en el archivo; los capturados en la plataforma se marcan', () => {
    const p = plan(
      [record()],
      [
        existing({}),
        existing({ id: 'c-2', contract_number: '7400012527' }),
        existing({
          id: 'c-3',
          contract_number: '7400099999',
          created_by: 'ingrid',
        }),
      ],
    );
    expect(p.missing.map((m) => [m.contract_number, m.fromPlatform])).toEqual([
      ['7400012527', false],
      ['7400099999', true],
    ]);
  });
});

// ── I6 (go-live 2026-09-30): la base real de Diana ─────────────────────

/** Fila de Control_de_contratos_A3T.xlsx ("Hoja1"), como la da SheetJS sin cellDates. */
const real = (overrides: Record<string, unknown> = {}) => ({
  'Num. Tomo': 'Tomo 1',
  'Núm. Carpeta': 'A3T-0003',
  'Tipo de documento': 'Contrato',
  'Área usuaria': 'Medición',
  Comprador: null,
  Servicio: 'Servicio de facturación',
  Proveedor: 'NXTVIEW S.A DE C.V.',
  Estatus: 'Vigente',
  'Fecha inicio': 45314, // 2024-01-23
  Plazo: '12 meses ',
  'Fecha Fin': 45679.2, // I3+(12*30.6): 2025-01-22 con horas
  'Monto Adjudicado': 455000,
  Moneda: 'MXN ',
  'Nombre del archivo': 'A3T-0003 Servicios de facturación - NXTVIEW - CONT',
  ...overrides,
});

const realPlan = (
  records: Array<Record<string, unknown>>,
  current: ExistingContract[] = [],
  extra: {
    suppliers?: typeof suppliers;
    buyers?: Array<{ id: string; full_name: string }>;
  } = {},
) => {
  const normalized = normalizeContractRows(records);
  return {
    normalized,
    plan: planContractImport({
      rows: normalized.rows,
      existing: current,
      suppliers: extra.suppliers ?? suppliers,
      buyers: extra.buyers,
      options: { today: TODAY, update: true },
    }),
  };
};

describe('I6: hoja, columnas y número por carpeta + tipo', () => {
  it('elige la hoja con los encabezados (Hoja2 son los catálogos y va primero)', () => {
    expect(
      pickContractSheet([
        {
          name: 'Hoja2',
          headers: ['Contrato', 'USD', 'Vigente', 'Operaciones'],
        },
        { name: 'Hoja1', headers: Object.keys(real()) },
      ]),
    ).toBe('Hoja1');
    expect(
      pickContractSheet([{ name: 'X', headers: ['Algo', 'Otra'] }]),
    ).toBeNull();
  });

  it('lee los alias de la base real: carpeta, tomo, tipo, área, plazo, estatus y archivo', () => {
    const { rows } = normalizeContractRows([real()]);
    expect(rows[0]).toMatchObject({
      number: 'A3T-0003',
      carpeta: 'A3T-0003',
      documentLabel: 'Contrato',
      documentType: 'contrato',
      tomo: 'Tomo 1',
      userArea: 'Medición',
      term: '12 meses',
      excelStatus: 'vigente',
      amount: 455000,
      currency: 'MXN',
      documentRef: 'A3T-0003 Servicios de facturación - NXTVIEW - CONT',
    });
  });

  it('carpeta + tipo → número; el segundo contrato de la carpeta lleva -2', () => {
    const tipos = [
      ['A3T-0003', 'Carta de Intencion'],
      ['A3T-0003', 'Contrato'],
      ['A3T-0022', 'Enmienda 3'],
      ['A3T-0022', 'Convenio Modificatorio'],
      ['A3T-0010', 'Contrato'],
      ['A3T-0010', 'Contrato'],
      ['A3T-0050', 'Terminación'],
      ['A3T-0051', 'Acta recepción'],
      ['A3T-0052', 'Cesion de derechos'],
      ['A3T-0053', 'Otro'],
    ];
    const { rows } = normalizeContractRows(
      tipos.map(([carpeta, tipo]) =>
        real({ 'Núm. Carpeta': carpeta, 'Tipo de documento': tipo }),
      ),
    );
    expect(
      rows.map((r) => [r.number, r.documentLabel, r.documentType]),
    ).toEqual([
      ['A3T-0003-CI', 'Carta de intención', 'carta_compromiso'],
      ['A3T-0003', 'Contrato', 'contrato'],
      ['A3T-0022-E3', 'Enmienda 3', 'addenda'],
      ['A3T-0022-CM', 'Convenio modificatorio', 'convenio'],
      ['A3T-0010', 'Contrato', 'contrato'],
      ['A3T-0010-2', 'Contrato', 'contrato'],
      ['A3T-0050-TER', 'Terminación', 'otro'],
      ['A3T-0051-AR', 'Acta de recepción', 'otro'],
      ['A3T-0052-CD', 'Cesión de derechos', 'otro'],
      ['A3T-0053-OT', 'Otro', 'otro'],
    ]);
  });

  it('las filas vacías (solo carpeta y tomo) se saltan y se reportan', () => {
    const empty = {
      'Num. Tomo': 'Tomo 16',
      'Núm. Carpeta': 'A3T-0160',
      'Tipo de documento': 'Contrato',
    };
    const { rows, skipped } = normalizeContractRows([real(), empty]);
    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([{ rowNumber: 3, ref: 'A3T-0160 · Tomo 16' }]);
  });
});

describe('I6: fechas', () => {
  it('texto dd/mm/aaaa con el DÍA primero; "NA" o "." = vacío', () => {
    expect(parseExcelDate('25/04/2024')).toEqual(D('2024-04-25'));
    expect(parseExcelDate('05/11/2025')).toEqual(D('2025-11-05'));
    expect(parseExcelDate('NA')).toBeNull();
    expect(parseExcelDate('.')).toBeNull();
    expect(readExcelDate('31/02/2025')).toEqual({
      date: null,
      unreadable: '31/02/2025',
    });
  });

  it('serial de Excel sin la fracción del día (la fórmula de Fecha Fin trae horas)', () => {
    expect(parseExcelDate(45314)).toEqual(D('2024-01-23'));
    expect(parseExcelDate(45414.2)).toEqual(D('2024-05-02'));
    expect(parseExcelDate(45413.99)).toEqual(D('2024-05-01'));
  });

  it('las ilegibles se reportan y la fila se importa con la fecha vacía', () => {
    const { rows, unreadableDates } = normalizeContractRows([
      real({ 'Fecha inicio': 'a definir', 'Fecha Fin': 'NA' }),
    ]);
    expect(rows[0]).toMatchObject({ startDate: null, endDate: null });
    expect(unreadableDates).toEqual([
      { rowNumber: 2, ref: 'A3T-0003', field: 'inicio', value: 'a definir' },
    ]);
  });
});

describe('I6: plan con la base real', () => {
  it('sin fecha de fin: estatus del Excel normalizado o vigente, y al reporte', () => {
    const { plan: p } = realPlan([
      real({ 'Fecha Fin': 'NA', Plazo: 'PERMANENTE', Estatus: 'VENCIDO' }),
      real({ 'Núm. Carpeta': 'A3T-0004', 'Fecha Fin': null, Estatus: null }),
    ]);
    expect(
      p.create.map((c) => [
        c.data.contract_number,
        c.data.end_date,
        c.data.status,
      ]),
    ).toEqual([
      ['A3T-0003', null, 'vencido'],
      ['A3T-0004', null, 'vigente'],
    ]);
    expect(p.report.noEndDate).toEqual(['A3T-0003', 'A3T-0004']);
    expect(p.create[0].data.notes).toContain('Plazo: permanente.');
  });

  it('con fecha de fin manda la fecha; el estatus del Excel que la contradice se reporta', () => {
    const { plan: p } = realPlan([real({ Estatus: 'Vigente' })]);
    expect(p.create[0].data).toMatchObject({
      contract_number: 'A3T-0003',
      carpeta: 'A3T-0003',
      document_label: 'Contrato',
      user_area: 'Medición',
      start_date: D('2024-01-23'),
      end_date: D('2025-01-22'),
      status: 'vencido',
      total_amount: 455000,
      currency: 'MXN',
    });
    expect(p.create[0].data.notes).toContain(
      'Documento (SharePoint): A3T-0003 Servicios de facturación - NXTVIEW - CONT.',
    );
    expect(p.report.statusContradictions).toEqual([
      {
        ref: 'A3T-0003',
        excel: 'vigente',
        byDate: 'vencido',
        end: '2025-01-22',
      },
    ]);
  });

  it('monto sin moneda: no se importa y va al reporte (nunca se inventa la moneda)', () => {
    const { plan: p } = realPlan([
      real({ Moneda: null, 'Monto Adjudicado': 400144.37 }),
    ]);
    expect(p.create[0].data).toMatchObject({
      total_amount: null,
      currency: null,
    });
    expect(p.report.amountWithoutCurrency).toEqual(['A3T-0003: 400144.37']);
  });

  it('"NA", "." y monedas con variantes ("MXN ", "usd", "EUROS")', () => {
    const { rows } = normalizeContractRows([
      real({ 'Monto Adjudicado': 'NA', Moneda: 'NA' }),
      real({
        'Núm. Carpeta': 'A3T-0004',
        'Monto Adjudicado': '.',
        Moneda: 'usd',
      }),
      real({ 'Núm. Carpeta': 'A3T-0005', Moneda: 'EUROS' }),
    ]);
    expect(rows.map((r) => [r.amount, r.currency])).toEqual([
      [null, null],
      [null, 'USD'],
      [455000, 'EUR'],
    ]);
  });

  it('proveedores: catálogo sin la forma jurídica; las variantes del archivo se unifican en una alta', () => {
    expect(matchSupplier('UVX', suppliers).entry?.id).toBe('sup-uvx');
    const { plan: p } = realPlan([
      real({ Proveedor: 'SOLUCIONES MARÍTIMAS DEL CARMEN SA DE CV' }),
      real({
        'Núm. Carpeta': 'A3T-0004',
        Proveedor: 'Soluciones Maritimas del Carmen',
      }),
      real({ 'Núm. Carpeta': 'A3T-0005', Proveedor: 'SAYFI' }),
    ]);
    expect(p.create.map((c) => c.data.new_supplier_name)).toEqual([
      'SOLUCIONES MARÍTIMAS DEL CARMEN SA DE CV',
      'SOLUCIONES MARÍTIMAS DEL CARMEN SA DE CV',
      'SAYFI',
    ]);
    expect(p.report.newSuppliers).toEqual([
      {
        name: 'SOLUCIONES MARÍTIMAS DEL CARMEN SA DE CV',
        variants: [
          'SOLUCIONES MARÍTIMAS DEL CARMEN SA DE CV',
          'Soluciones Maritimas del Carmen',
        ],
        rows: ['A3T-0003', 'A3T-0004'],
      },
      { name: 'SAYFI', variants: ['SAYFI'], rows: ['A3T-0005'] },
    ]);
  });

  it('comprador por nombre (exacto o prefijo único); el que no cuadra se reporta', () => {
    const buyers = [
      { id: 'u-1', full_name: 'Mariana López' },
      { id: 'u-2', full_name: 'Jorge Hernández' },
    ];
    const { plan: p } = realPlan(
      [
        real({ Comprador: 'mariana lopez' }),
        real({ 'Núm. Carpeta': 'A3T-0004', Comprador: 'Jorge' }),
        real({ 'Núm. Carpeta': 'A3T-0005', Comprador: 'Laura' }),
      ],
      [],
      { buyers },
    );
    expect(p.create.map((c) => c.data.buyer_profile_id)).toEqual([
      'u-1',
      'u-2',
      undefined,
    ]);
    expect(p.report.unmatchedBuyers).toEqual([
      { ref: 'A3T-0005', name: 'Laura' },
    ]);
  });

  it('una segunda corrida con el mismo archivo no cambia nada (mismos números)', () => {
    const records = [
      real(),
      real({ 'Tipo de documento': 'Carta de Intencion' }),
    ];
    const first = realPlan(records).plan;
    const stored: ExistingContract[] = first.create.map((c, i) =>
      existing({
        id: `n-${i}`,
        contract_number: c.data.contract_number,
        tomo: c.data.tomo ?? null,
        document_type: c.data.document_type,
        service_description: c.data.service_description,
        supplier_id: 'sup-nxt',
        supplier_name: 'NXTVIEW S.A DE C.V.',
        start_date: c.data.start_date,
        end_date: c.data.end_date,
        total_amount: c.data.total_amount ?? null,
        currency: c.data.currency ?? null,
        responsible_user_name: null,
        status: c.data.status,
        notes: c.data.notes ?? null,
        carpeta: c.data.carpeta ?? null,
        document_label: c.data.document_label ?? null,
        user_area: c.data.user_area ?? null,
      }),
    );
    const second = realPlan(records, stored, {
      suppliers: [
        ...suppliers,
        {
          id: 'sup-nxt',
          legal_name: 'NXTVIEW S.A DE C.V.',
          key: compact('NXTVIEW S.A DE C.V.'),
        },
      ],
    }).plan;
    expect(second.create).toEqual([]);
    expect(second.update).toEqual([]);
    expect(second.unchanged).toEqual(['A3T-0003', 'A3T-0003-CI']);
  });
});

describe('J2: el que entra ya vencido es histórico (sin avisos)', () => {
  it('vencido por fecha o por el Excel sin fecha de fin → histórico; vigente no', () => {
    const { plan: p } = realPlan([
      real(), // fin 2025-01-22: vencido
      real({
        'Núm. Carpeta': 'A3T-0004',
        'Fecha Fin': 'NA',
        Estatus: 'Vencido',
      }),
      real({ 'Núm. Carpeta': 'A3T-0005', 'Fecha Fin': '31/12/2099' }),
    ]);
    expect(
      p.create.map((c) => [
        c.data.contract_number,
        c.data.status,
        c.data.vencido_historico,
      ]),
    ).toEqual([
      ['A3T-0003', 'vencido', true],
      ['A3T-0004', 'vencido', true],
      ['A3T-0005', 'vigente', false],
    ]);
  });
});

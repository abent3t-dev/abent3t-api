import {
  compact,
  type ExistingContract,
  normalizeContractRows,
  parseAmount,
  parseCurrency,
  planContractImport,
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

  it('proveedor ambiguo, vigencia incompleta o contrato repetido → error y la fila no se toca', () => {
    const p = plan(
      [
        record({ Contrato: 1, Proveedor: 'Honeywell Mexico SA' }),
        record({ Contrato: 2, 'Fecha Fin': null }),
        record({ Contrato: 3 }),
        record({ Contrato: 3 }),
      ],
      [],
    );
    expect(p.errors).toHaveLength(3);
    expect(p.create.map((c) => c.data.contract_number)).toEqual(['3']);
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

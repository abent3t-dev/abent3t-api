import {
  maximoApprovalLevel,
  maximoApproverEvents,
  maximoPendingLevel,
  SapApprovalDoc,
  sapApproverEvents,
  sapLineReachedAt,
  summarizeApprovers,
  summarizeMaximoLevels,
} from './approver-stats';

/**
 * G5/G6 (2026-09-28): días desde que el documento LE LLEGÓ al aprobador y
 * pendientes de hoy con su antigüedad.
 */

const T = (iso: string) => `${iso}T00:00:00Z`;
const D = (iso: string) => new Date(T(iso));
const TODAY = D('2026-09-28');

const doc = (overrides: Partial<SapApprovalDoc>): SapApprovalDoc => ({
  code: 1,
  status: 'arsApproved',
  current_stage: null,
  creation_date: D('2026-09-01'),
  approvers: [],
  ...overrides,
});

describe('SAP: cuándo le llegó el documento', () => {
  const twoStages = doc({
    approvers: [
      {
        stage_code: 10,
        user_name: 'Ingrid',
        status: 'ardApproved',
        update_date: T('2026-09-03'),
      },
      {
        stage_code: 10,
        user_name: 'Otro',
        status: 'ardApproved',
        update_date: T('2026-09-04'),
      },
      {
        stage_code: 20,
        user_name: 'David',
        status: 'ardApproved',
        update_date: T('2026-09-12'),
      },
    ],
  });

  it('primera etapa: desde la creación; aprobaciones de su misma etapa no cuentan', () => {
    expect(sapLineReachedAt(twoStages, twoStages.approvers[1])).toBe(
      D('2026-09-01').getTime(),
    );
  });

  it('segunda etapa: desde la última aprobación de la etapa anterior', () => {
    expect(sapLineReachedAt(twoStages, twoStages.approvers[2])).toBe(
      D('2026-09-04').getTime(),
    );
  });

  it('aprobadas: días hasta su decisión; rechazadas cuentan aparte', () => {
    const events = sapApproverEvents(
      [
        twoStages,
        doc({
          code: 2,
          status: 'arsNotApproved',
          approvers: [
            {
              stage_code: 10,
              user_name: 'David',
              status: 'ardNotApproved',
              update_date: T('2026-09-05'),
            },
          ],
        }),
      ],
      TODAY,
    );
    const david = events.filter((e) => e.usuario === 'David');
    expect(david.map((e) => [e.decision, e.days])).toEqual([
      ['aprobada', 8], // 4 → 12 sep
      ['rechazada', 4], // 1 → 5 sep
    ]);
  });
});

describe('SAP: pendientes de hoy (G5)', () => {
  const pending = doc({
    code: 3,
    status: 'arsPending',
    current_stage: 20,
    creation_date: D('2026-08-01'),
    approvers: [
      {
        stage_code: 10,
        user_name: 'Ingrid',
        status: 'ardApproved',
        update_date: T('2026-09-18'),
      },
      {
        stage_code: 20,
        user_name: 'David',
        status: 'ardPending',
        update_date: T('2026-09-18'),
      },
      // etapa futura: todavía no le llega
      {
        stage_code: 30,
        user_name: 'Uriel',
        status: 'ardPending',
        update_date: null,
      },
    ],
  });

  it('solo la etapa actual, con la antigüedad desde que le llegó (no desde la creación)', () => {
    const events = sapApproverEvents([pending], TODAY).filter(
      (e) => e.decision === 'pendiente',
    );
    expect(events.map((e) => [e.usuario, e.days])).toEqual([['David', 10]]);
  });

  it('"David parece el mejor": aprueba rápido lo poco que aprueba, pero lo detenido se ve', () => {
    const fast = doc({
      code: 4,
      approvers: [
        {
          stage_code: 20,
          user_name: 'David',
          status: 'ardApproved',
          update_date: T('2026-09-02'),
        },
      ],
    });
    const [david] = summarizeApprovers(
      sapApproverEvents([fast, pending], TODAY),
      { from: D('2026-01-01'), to: D('2026-09-30') },
      { withPending: true, withRejected: true },
    ).filter((r) => r.usuario === 'David');
    expect(david).toMatchObject({
      aprobadas: { total: 1, dias_promedio: 1 },
      rechazadas: 0,
      pendientes: { total: 1, dias_promedio: 10, dias_max: 10 },
    });
  });

  it('el periodo filtra por la fecha de la decisión; los pendientes son de hoy', () => {
    const old = doc({
      code: 5,
      approvers: [
        {
          stage_code: 20,
          user_name: 'David',
          status: 'ardApproved',
          update_date: T('2025-01-10'),
        },
      ],
    });
    const [david] = summarizeApprovers(
      sapApproverEvents([old, pending], TODAY),
      { from: D('2026-01-01'), to: D('2026-09-30') },
      { withPending: true, withRejected: true },
    ).filter((r) => r.usuario === 'David');
    expect(david.aprobadas.total).toBe(0);
    expect(david.pendientes?.total).toBe(1);
  });
});

describe('Maximo: cadena de aprobación (G6)', () => {
  it('niveles del historial POSTATUS', () => {
    expect(maximoApprovalLevel('APPR1')?.label).toBe('Nivel 1');
    expect(maximoApprovalLevel('APPR3REV')?.label).toBe('Nivel 3 (revisión)');
    expect(maximoApprovalLevel('APPR')?.label).toBe('Aprobación final');
    expect(maximoApprovalLevel('REVISD')?.label).toBe('Revisión aprobada');
    expect(maximoApprovalLevel('WAPPR')).toBeNull();
    expect(maximoApprovalLevel('INPRG')).toBeNull();
  });

  it('nivel que espera una OC en aprobación', () => {
    expect(maximoPendingLevel('WAPPR')).toEqual({
      nivel: 1,
      etiqueta: 'Nivel 1',
    });
    expect(maximoPendingLevel('APPR1')).toEqual({
      nivel: 2,
      etiqueta: 'Nivel 2 o aprobación final',
    });
    expect(maximoPendingLevel('APPR1REV')?.nivel).toBe(2);
    expect(maximoPendingLevel('APPR')).toBeNull();
  });

  const history = [
    // WAPPR 1-sep → DAROJE nivel 1 el 5 → MAOG1 nivel 2 el 6 → GMV1 final el 9
    {
      status: 'APPR1',
      changed_by: 'DAROJE',
      change_date: D('2026-09-05'),
      prev_date: D('2026-09-01'),
    },
    {
      status: 'APPR2',
      changed_by: 'MAOG1',
      change_date: D('2026-09-06'),
      prev_date: D('2026-09-05'),
    },
    {
      status: 'APPR',
      changed_by: 'GMV1',
      change_date: D('2026-09-09'),
      prev_date: D('2026-09-06'),
    },
    {
      status: 'APPR1',
      changed_by: 'DAROJE',
      change_date: D('2026-09-20'),
      prev_date: D('2026-09-18'),
    },
    // fuera del periodo
    {
      status: 'APPR1',
      changed_by: 'DAROJE',
      change_date: D('2025-02-01'),
      prev_date: D('2025-01-01'),
    },
  ];
  const period = { from: D('2026-01-01'), to: D('2026-09-30') };

  it('por aprobador: aparecen Miguel (MAOG1) y Gilberto (GMV1), cada uno con su nivel', () => {
    const rows = summarizeApprovers(maximoApproverEvents(history), period, {
      withPending: false,
      withRejected: false,
    });
    expect(
      rows.map((r) => [
        r.usuario,
        r.aprobadas.total,
        r.aprobadas.dias_promedio,
        r.niveles,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['DAROJE', 2, 3, ['Nivel 1']],
        ['MAOG1', 1, 1, ['Nivel 2']],
        ['GMV1', 1, 3, ['Aprobación final']],
      ]),
    );
    // Maximo no registra rechazos ni a quién le toca lo pendiente
    expect(rows[0].rechazadas).toBeNull();
    expect(rows[0].pendientes).toBeNull();
  });

  it('tiempos por nivel del periodo', () => {
    expect(summarizeMaximoLevels(history, period)).toEqual([
      { nivel: 'Nivel 1', aprobaciones: 2, dias_promedio: 3, dias_mediana: 3 },
      { nivel: 'Nivel 2', aprobaciones: 1, dias_promedio: 1, dias_mediana: 1 },
      {
        nivel: 'Aprobación final',
        aprobaciones: 1,
        dias_promedio: 3,
        dias_mediana: 3,
      },
    ]);
  });
});

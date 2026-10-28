import {
  canDecide,
  canReopen,
  canSubmit,
  canWithdraw,
  diffSnapshots,
  senderOfRound,
  signedInRound,
  turnLabel,
  type FlowActor,
  type FlowEvent,
  type FlowState,
  type SnapshotBody,
} from './fpa-flow';

/**
 * FP&A (B3) — de quién es el turno en el flujo de un presupuesto, con el caso
 * de Compras: Diana captura, Ingrid aprueba el área, David firma planeación
 * (Laura de suplente) y Uriel firma el CFO.
 */

const actor = (id: string, roles: string[]): FlowActor => ({ id, roles });
const DIANA = actor('diana', ['fpa_area']);
const INGRID = actor('ingrid', ['fpa_area']);
const DAVID = actor('david', ['fpa_planeacion']);
const LAURA = actor('laura', ['fpa_planeacion']);
const LILIANA = actor('liliana', ['fpa_planeacion']);
const URIEL = actor('uriel', ['fpa_cfo']);
const ALEX = actor('alex', ['super_admin']);

const ASSIGNMENTS = [
  {
    profile_id: 'diana',
    duty: 'captura',
    area_id: 'compras',
    is_alternate: false,
  },
  {
    profile_id: 'ingrid',
    duty: 'aprobacion',
    area_id: 'compras',
    is_alternate: false,
  },
  {
    profile_id: 'david',
    duty: 'planeacion',
    area_id: null,
    is_alternate: false,
  },
  {
    profile_id: 'laura',
    duty: 'planeacion',
    area_id: null,
    is_alternate: true,
  },
];

const state = (over: Partial<FlowState> = {}): FlowState => ({
  status: 'borrador',
  round: 0,
  version_status: 'captura',
  area_id: 'compras',
  assignments: ASSIGNMENTS,
  events: [],
  line_count: 5,
  has_unavailable: false,
  ...over,
});

const sent = (round: number, by = 'diana'): FlowEvent => ({
  round,
  action: 'enviado',
  step: null,
  actor_profile_id: by,
});
const approved = (round: number, step: string, by: string): FlowEvent => ({
  round,
  action: 'aprobado',
  step,
  actor_profile_id: by,
});

describe('fpa-flow — enviar', () => {
  it('quien captura el área lo envía; planeación no envía por el área (decisión 3)', () => {
    expect(canSubmit(DIANA, state())).toMatchObject({
      ok: true,
      acting_as: 'titular',
      actor_role: 'fpa_area',
    });
    expect(canSubmit(LAURA, state())).toEqual({
      ok: false,
      code: 'persona',
      reason: 'Solo quien captura el área lo envía',
    });
    expect(canSubmit(INGRID, state())).toMatchObject({ ok: false });
  });

  it('un devuelto o un retirado se reenvía; uno enviado o aprobado, no', () => {
    expect(canSubmit(DIANA, state({ status: 'devuelto', round: 1 })).ok).toBe(
      true,
    );
    expect(canSubmit(DIANA, state({ status: 'borrador', round: 1 })).ok).toBe(
      true,
    );
    expect(canSubmit(DIANA, state({ status: 'enviado', round: 1 }))).toEqual({
      ok: false,
      code: 'estado',
      reason: 'El presupuesto ya está en aprobación o aprobado',
    });
    expect(
      canSubmit(DIANA, state({ status: 'aprobado_cfo', round: 1 })).ok,
    ).toBe(false);
  });

  it('sin líneas, con una "No disponible", sin aprobador o con la versión fuera de captura, no se envía', () => {
    expect(canSubmit(DIANA, state({ line_count: 0 }))).toMatchObject({
      ok: false,
      code: 'estado',
    });
    expect(canSubmit(DIANA, state({ has_unavailable: true }))).toMatchObject({
      ok: false,
      code: 'estado',
    });
    const noApprover = ASSIGNMENTS.filter((a) => a.duty !== 'aprobacion');
    expect(canSubmit(DIANA, state({ assignments: noApprover }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no tiene quien la apruebe/) as unknown,
    });
    expect(
      canSubmit(DIANA, state({ version_status: 'cerrada' })),
    ).toMatchObject({ ok: false, code: 'estado' });
  });

  it('a quien no captura se le dice eso antes que lo que le falta al presupuesto', () => {
    expect(canSubmit(INGRID, state({ line_count: 0 }))).toMatchObject({
      code: 'persona',
    });
  });
});

describe('fpa-flow — aprobar y rechazar', () => {
  it('el paso del área es de quien lo aprueba; no de planeación ni del CFO', () => {
    const s = state({ status: 'enviado', round: 1, events: [sent(1)] });
    expect(canDecide(INGRID, s)).toMatchObject({
      ok: true,
      step: 'area',
      acting_as: 'titular',
    });
    expect(canDecide(DAVID, s)).toEqual({
      ok: false,
      code: 'persona',
      reason: 'Lo firma quien aprueba el área',
    });
    expect(canDecide(URIEL, s).ok).toBe(false);
  });

  it('planeación con firmantes registrados: David (titular) o Laura (suplente); Liliana no', () => {
    const s = state({
      status: 'aprobado_area',
      round: 1,
      events: [sent(1), approved(1, 'area', 'ingrid')],
    });
    expect(canDecide(DAVID, s)).toMatchObject({
      ok: true,
      step: 'planeacion',
      acting_as: 'titular',
      actor_role: 'fpa_planeacion',
    });
    expect(canDecide(LAURA, s)).toMatchObject({
      ok: true,
      acting_as: 'suplente',
    });
    expect(canDecide(LILIANA, s)).toEqual({
      ok: false,
      code: 'persona',
      reason: 'Lo firma el firmante de planeación',
    });
  });

  it('el CFO sin firmantes registrados: cualquiera con el rol', () => {
    const s = state({
      status: 'aprobado_planeacion',
      round: 1,
      events: [
        sent(1),
        approved(1, 'area', 'ingrid'),
        approved(1, 'planeacion', 'david'),
      ],
    });
    expect(canDecide(URIEL, s)).toMatchObject({
      ok: true,
      step: 'cfo',
      acting_as: 'rol',
      actor_role: 'fpa_cfo',
    });
    expect(canDecide(DAVID, s)).toMatchObject({
      ok: false,
      reason:
        'Ya firmaste el paso de planeación en esta ronda: este lo firma otra persona',
    });
  });

  it('nadie firma lo que envió (tampoco el suplente que capturó)', () => {
    const asg = [
      ...ASSIGNMENTS,
      {
        profile_id: 'ingrid',
        duty: 'captura',
        area_id: 'compras',
        is_alternate: true,
      },
    ];
    const s = state({
      status: 'enviado',
      round: 1,
      assignments: asg,
      events: [sent(1, 'ingrid')],
    });
    expect(canDecide(INGRID, s)).toEqual({
      ok: false,
      code: 'persona',
      reason: 'Tú lo enviaste: lo firma otra persona',
    });
  });

  it('nadie firma dos pasos de la misma ronda (DG: David aprueba el área y no firma planeación)', () => {
    const asg = [
      {
        profile_id: 'laura',
        duty: 'captura',
        area_id: 'dg',
        is_alternate: false,
      },
      {
        profile_id: 'david',
        duty: 'aprobacion',
        area_id: 'dg',
        is_alternate: false,
      },
      ...ASSIGNMENTS.filter((a) => a.area_id === null),
    ];
    const s = state({
      area_id: 'dg',
      status: 'aprobado_area',
      round: 1,
      assignments: asg,
      events: [sent(1, 'laura'), approved(1, 'area', 'david')],
    });
    expect(canDecide(DAVID, s)).toMatchObject({
      ok: false,
      reason:
        'Ya firmaste el paso del área en esta ronda: este lo firma otra persona',
    });
    // Laura (suplente de planeación) tampoco: ella lo envió
    expect(canDecide(LAURA, s)).toMatchObject({
      reason: 'Tú lo enviaste: lo firma otra persona',
    });
  });

  it('en una ronda nueva se vale volver a firmar el mismo paso', () => {
    const s = state({
      status: 'enviado',
      round: 2,
      events: [sent(1), approved(1, 'area', 'ingrid'), sent(2)],
    });
    expect(canDecide(INGRID, s).ok).toBe(true);
    expect(signedInRound(s).size).toBe(0);
    expect(senderOfRound(s)).toBe('diana');
  });

  it('borrador, devuelto y aprobado no esperan firma; tampoco con la versión cerrada', () => {
    for (const status of ['borrador', 'devuelto', 'aprobado_cfo'] as const) {
      expect(canDecide(INGRID, state({ status, round: 1 }))).toMatchObject({
        ok: false,
        code: 'estado',
      });
    }
    expect(
      canDecide(
        INGRID,
        state({ status: 'enviado', round: 1, version_status: 'cerrada' }),
      ),
    ).toMatchObject({ code: 'estado' });
  });

  it('super_admin actúa como soporte, pero tampoco firma lo que envió', () => {
    const s = state({ status: 'enviado', round: 1, events: [sent(1, 'alex')] });
    expect(canDecide(ALEX, s)).toMatchObject({
      reason: 'Tú lo enviaste: lo firma otra persona',
    });
    const s2 = state({ status: 'enviado', round: 1, events: [sent(1)] });
    expect(canDecide(ALEX, s2)).toMatchObject({
      ok: true,
      acting_as: 'super_admin',
      actor_role: 'super_admin',
    });
  });
});

describe('fpa-flow — retirar y reabrir', () => {
  it('retira quien lo envió, antes de la primera firma', () => {
    const s = state({ status: 'enviado', round: 1, events: [sent(1)] });
    expect(canWithdraw(DIANA, s).ok).toBe(true);
    expect(canWithdraw(INGRID, s)).toEqual({
      ok: false,
      code: 'persona',
      reason: 'Solo quien lo envió lo retira',
    });
    expect(
      canWithdraw(
        DIANA,
        state({
          status: 'aprobado_area',
          round: 1,
          events: [sent(1), approved(1, 'area', 'ingrid')],
        }),
      ),
    ).toMatchObject({ ok: false, code: 'estado' });
  });

  it('si ya no captura el área, no lo retira (lo regresa quien lo aprueba)', () => {
    const s = state({
      status: 'enviado',
      round: 1,
      events: [sent(1)],
      assignments: ASSIGNMENTS.filter((a) => a.profile_id !== 'diana'),
    });
    expect(canWithdraw(DIANA, s)).toMatchObject({ ok: false, code: 'persona' });
  });

  it('reabre planeación un aprobado, mientras la versión no esté cerrada', () => {
    const s = state({ status: 'aprobado_cfo', round: 1 });
    expect(canReopen(LILIANA, s)).toMatchObject({
      ok: true,
      acting_as: 'rol',
      actor_role: 'fpa_planeacion',
    });
    expect(canReopen(URIEL, s)).toMatchObject({ ok: false, code: 'persona' });
    expect(
      canReopen(
        LILIANA,
        state({ status: 'aprobado_cfo', round: 1, version_status: 'cerrada' }),
      ),
    ).toMatchObject({ code: 'estado' });
    expect(
      canReopen(LILIANA, state({ status: 'aprobado_area', round: 1 })).ok,
    ).toBe(false);
  });

  it('el turno, para mostrar', () => {
    expect(turnLabel('borrador', 0)).toBe('En captura: nunca enviado');
    expect(turnLabel('borrador', 2)).toBe('Retirado: en captura otra vez');
    expect(turnLabel('aprobado_area', 1)).toBe('Turno de planeación');
  });
});

describe('fpa-flow — qué cambió entre rondas', () => {
  const ronda1: SnapshotBody = {
    total_mxn: '340000.00',
    lines: [
      {
        line_key_id: 'k1',
        folio: 'L-000001',
        concept: 'Evaluación de proveedores',
        total_mxn: '150000.00',
        months: [{ month: 3, amount_mxn: '150000.00' }],
        supplier_name: 'FIDELITAS',
      },
      {
        line_key_id: 'k2',
        folio: 'L-000002',
        concept: 'Mapeo de procesos',
        total_mxn: '190000.00',
        months: [{ month: 5, amount_mxn: '190000.00' }],
      },
    ],
  };

  it('la ronda 2 (después del rechazo de planeación) dice qué se agregó, quitó o cambió', () => {
    const ronda2: SnapshotBody = {
      total_mxn: '330000.00',
      lines: [
        {
          line_key_id: 'k1',
          folio: 'L-000001',
          concept: 'Evaluación de proveedores',
          total_mxn: '150000.00',
          months: [{ month: 4, amount_mxn: '150000.00' }],
          supplier_name: 'AQUILES',
        },
        {
          line_key_id: 'k3',
          folio: 'L-000003',
          concept: 'Curso de negociación',
          total_mxn: '180000.00',
        },
      ],
    };
    expect(diffSnapshots(ronda1, ronda2)).toEqual({
      total_before: '340000.00',
      total_after: '330000.00',
      delta: '-10000.00',
      added: [
        {
          folio: 'L-000003',
          concept: 'Curso de negociación',
          total_mxn: '180000.00',
        },
      ],
      removed: [
        {
          folio: 'L-000002',
          concept: 'Mapeo de procesos',
          total_mxn: '190000.00',
        },
      ],
      changed: [
        {
          folio: 'L-000001',
          concept: 'Evaluación de proveedores',
          total_mxn: '150000.00',
          total_before: '150000.00',
          fields: ['Proveedor', 'Meses'],
        },
      ],
    });
  });

  it('sin cambios, todo vacío y diferencia en cero', () => {
    expect(diffSnapshots(ronda1, ronda1)).toMatchObject({
      delta: '0.00',
      added: [],
      removed: [],
      changed: [],
    });
  });
});

import {
  captureClosed,
  captureUntil,
  captureWindow,
  dayLabel,
  isRealDay,
  nextDay,
  pastDeadline,
  todayMx,
  type DeadlineInput,
} from './fpa-deadline';
import {
  canSubmit,
  canWithdraw,
  type FlowActor,
  type FlowState,
} from './fpa-flow';

/**
 * FP&A (C4) — fecha límite de captura, con lo que contestó Laura el 10-nov:
 * una fecha para todas las áreas, al vencer se bloquea y las firmas no llevan
 * fecha. La prórroga de un área vale si es más tarde.
 */

const B26: DeadlineInput = {
  version_status: 'captura',
  status: 'borrador',
  deadline: '2026-11-20',
  extended_until: null,
};

describe('fecha límite de captura (C4)', () => {
  it('el día de la fecha todavía se captura; al siguiente, ya no', () => {
    expect(captureClosed(B26, '2026-11-19')).toBe(false);
    expect(captureClosed(B26, '2026-11-20')).toBe(false);
    expect(captureClosed(B26, '2026-11-21')).toBe(true);
  });

  it('sin fecha, nunca cierra (como hasta hoy)', () => {
    expect(captureClosed({ ...B26, deadline: null }, '2030-01-01')).toBe(false);
    expect(captureUntil(null, '2026-11-25')).toBeNull();
  });

  it('un devuelto se corrige sin fecha: las firmas no llevan fecha', () => {
    const devuelto = { ...B26, status: 'devuelto' };
    expect(captureClosed(devuelto, '2026-12-15')).toBe(false);
    // pero la fecha ya pasó (para retirar un enviado)
    expect(pastDeadline({ ...B26, status: 'enviado' }, '2026-11-21')).toBe(
      true,
    );
  });

  it('solo cuenta con la versión abierta a captura', () => {
    expect(
      captureClosed({ ...B26, version_status: 'preparacion' }, '2026-12-01'),
    ).toBe(false);
    expect(
      captureClosed({ ...B26, version_status: 'cerrada' }, '2026-12-01'),
    ).toBe(false);
  });

  it('la prórroga del área vale si es más tarde que la fecha de la versión', () => {
    expect(captureUntil('2026-11-20', '2026-11-25')).toBe('2026-11-25');
    expect(captureUntil('2026-11-20', '2026-11-18')).toBe('2026-11-20');
    const conProrroga = { ...B26, extended_until: '2026-11-25' };
    expect(captureClosed(conProrroga, '2026-11-24')).toBe(false);
    expect(captureClosed(conProrroga, '2026-11-26')).toBe(true);
    expect(captureWindow(conProrroga, '2026-11-24')).toEqual({
      deadline: '2026-11-20',
      extended_until: '2026-11-25',
      until: '2026-11-25',
      closed: false,
    });
  });

  it('hoy es el día de México, no el de UTC', () => {
    // 23:30 del 10-nov en México son las 05:30 del 11-nov en UTC
    expect(todayMx(new Date('2026-11-11T05:30:00Z'))).toBe('2026-11-10');
    expect(todayMx(new Date('2026-11-11T06:30:00Z'))).toBe('2026-11-11');
  });

  it('las fechas: que existan, el día siguiente y cómo se dicen', () => {
    expect(isRealDay('2026-11-20')).toBe(true);
    expect(isRealDay('2026-02-30')).toBe(false);
    expect(isRealDay('20-11-2026')).toBe(false);
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(dayLabel('2026-11-20')).toBe('20 de noviembre de 2026');
  });
});

describe('el flujo con la fecha de captura (C4)', () => {
  const CAPTURA: FlowActor = { id: 'cap', roles: ['fpa_area'] };
  const state = (over: Partial<FlowState> = {}): FlowState => ({
    status: 'borrador',
    round: 0,
    version_status: 'captura',
    area_id: 'compras',
    assignments: [
      {
        profile_id: 'cap',
        duty: 'captura',
        area_id: 'compras',
        is_alternate: false,
      },
      {
        profile_id: 'laura',
        duty: 'aprobacion',
        area_id: 'compras',
        is_alternate: false,
      },
    ],
    events: [],
    line_count: 3,
    has_unavailable: false,
    capture_until: '2026-11-20',
    past_deadline: false,
    ...over,
  });

  it('antes de la fecha se envía; después, ya no (409, para todos)', () => {
    expect(canSubmit(CAPTURA, state())).toMatchObject({ ok: true });
    expect(canSubmit(CAPTURA, state({ past_deadline: true }))).toEqual({
      ok: false,
      code: 'estado',
      reason:
        'La captura cerró el 20 de noviembre de 2026: planeación puede darle una prórroga al área',
    });
    // tampoco como soporte
    expect(
      canSubmit(
        { id: 'alex', roles: ['super_admin'] },
        state({ past_deadline: true }),
      ),
    ).toMatchObject({ ok: false, code: 'estado' });
  });

  it('un devuelto se reenvía aunque la fecha haya pasado', () => {
    const devuelto = state({
      status: 'devuelto',
      round: 1,
      past_deadline: true,
    });
    expect(canSubmit(CAPTURA, devuelto)).toMatchObject({ ok: true });
  });

  it('pasada la fecha, un enviado ya no se retira: lo regresa quien aprueba', () => {
    const enviado = state({
      status: 'enviado',
      round: 1,
      events: [
        { round: 1, action: 'enviado', step: null, actor_profile_id: 'cap' },
      ],
    });
    expect(canWithdraw(CAPTURA, enviado)).toMatchObject({ ok: true });
    expect(canWithdraw(CAPTURA, { ...enviado, past_deadline: true })).toEqual({
      ok: false,
      code: 'estado',
      reason:
        'La fecha de captura ya pasó (20 de noviembre de 2026): si hay que corregir algo, que lo regrese quien aprueba el área',
    });
  });
});

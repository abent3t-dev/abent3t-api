import {
  daysUntilDate,
  deriveDeliveryStatus,
  erpClosure,
  RISK_WINDOW_DAYS,
} from './expediting.status';

/** Fase Expeditación. Motor de estatus derivado: función pura, reloj fijo. */

const TODAY = new Date(Date.UTC(2026, 8, 1)); // 2026-09-01 (martes)
const day = (offset: number) => new Date(TODAY.getTime() + offset * 86_400_000);

const input = (
  overrides: Partial<Parameters<typeof deriveDeliveryStatus>[0]> = {},
) => ({
  expected_date: day(30),
  actual_delivery_date: null,
  po_status: 'emitida',
  tracking_status: null,
  ...overrides,
});

describe('deriveDeliveryStatus (T9: -15 naturales / vencida / +7)', () => {
  it('sin fecha esperada → sin_fecha', () => {
    expect(deriveDeliveryStatus(input({ expected_date: null }), TODAY)).toBe(
      'sin_fecha',
    );
  });

  it('lejos de la fecha → en_tiempo; justo FUERA de la ventana (16 días) también', () => {
    expect(deriveDeliveryStatus(input({ expected_date: day(30) }), TODAY)).toBe(
      'en_tiempo',
    );
    expect(
      deriveDeliveryStatus(
        input({ expected_date: day(RISK_WINDOW_DAYS + 1) }),
        TODAY,
      ),
    ).toBe('en_tiempo');
  });

  it('bordes de la ventana de riesgo: exactamente 15 días y el DÍA exacto', () => {
    expect(
      deriveDeliveryStatus(
        input({ expected_date: day(RISK_WINDOW_DAYS) }),
        TODAY,
      ),
    ).toBe('en_riesgo');
    // El mismo día de la entrega aún no está vencida
    expect(deriveDeliveryStatus(input({ expected_date: day(0) }), TODAY)).toBe(
      'en_riesgo',
    );
  });

  it('un día después de la fecha → retrasada (aunque caiga en fin de semana)', () => {
    expect(deriveDeliveryStatus(input({ expected_date: day(-1) }), TODAY)).toBe(
      'retrasada',
    );
    // Fecha esperada en sábado (2026-08-29) ya vencida al martes: días
    // NATURALES según §Alertas del doc — el fin de semana no la "salva"
    const saturday = new Date(Date.UTC(2026, 7, 29));
    expect(
      deriveDeliveryStatus(input({ expected_date: saturday }), TODAY),
    ).toBe('retrasada');
    expect(daysUntilDate(saturday, TODAY)).toBe(-3);
  });

  it('capturas mandan sobre fechas: parcial y entregada', () => {
    expect(
      deriveDeliveryStatus(
        input({ tracking_status: 'entregada_parcial', expected_date: day(-9) }),
        TODAY,
      ),
    ).toBe('parcial');
    expect(
      deriveDeliveryStatus(input({ po_status: 'entregada_parcial' }), TODAY),
    ).toBe('parcial');
    expect(
      deriveDeliveryStatus(
        input({ actual_delivery_date: day(-2), expected_date: day(-9) }),
        TODAY,
      ),
    ).toBe('entregada');
    expect(
      deriveDeliveryStatus(input({ po_status: 'entregada_completa' }), TODAY),
    ).toBe('entregada');
  });
});

describe('erpClosure (I1, 2026-09-30)', () => {
  const closure = (overrides: Partial<Parameters<typeof erpClosure>[0]>) =>
    erpClosure({ maximo_status: null, receipt_status: null, ...overrides });

  it('migrada abierta en SAP: CLOSE en Maximo → entregada; CAN → cancelada; INPRG → sigue', () => {
    expect(closure({ maximo_status: 'CLOSE' })).toEqual({
      status: 'entregada',
      closed_by: 'cerrada_maximo',
    });
    expect(closure({ maximo_status: 'CAN' })).toEqual({
      status: 'cancelada',
      closed_by: 'cancelada_maximo',
    });
    expect(closure({ maximo_status: 'INPRG' })).toBeNull();
  });

  it('Maximo con su copia en SAP cerrada → entregada; cancelada → cancelada', () => {
    expect(closure({ maximo_status: 'APPR', sap_closed: true })).toEqual({
      status: 'entregada',
      closed_by: 'cerrada_sap',
    });
    expect(closure({ maximo_status: 'INPRG', sap_cancelled: true })).toEqual({
      status: 'cancelada',
      closed_by: 'cancelada_sap',
    });
  });

  it('I1b: recepción COMPLETE cierra; PARTIAL y NONE no', () => {
    expect(
      closure({ maximo_status: 'INPRG', receipt_status: 'COMPLETE' }),
    ).toEqual({ status: 'entregada', closed_by: 'recepcion_completa' });
    expect(
      closure({ maximo_status: 'INPRG', receipt_status: 'PARTIAL' }),
    ).toBeNull();
    expect(
      closure({ maximo_status: 'INPRG', receipt_status: 'NONE' }),
    ).toBeNull();
  });

  it('SAP solo (sin Maximo ni recepción): sin cambio', () => {
    expect(closure({})).toBeNull();
  });
});

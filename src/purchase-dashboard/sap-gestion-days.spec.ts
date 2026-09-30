import {
  averageAndMedian,
  gestionDays,
  maximoGestionDays,
  sapGestionDays,
} from './sap-gestion-days';

/**
 * D3 (2026-09-23): días de gestión SAP = fecha de la OC − fecha de la
 * solicitud de pedido base (la más antigua si hay varias). Fixtures
 * OC+solicitud en memoria.
 */
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('sapGestionDays', () => {
  const requests = [
    { doc_entry: 100, doc_date: d('2026-09-01') },
    { doc_entry: 101, doc_date: d('2026-09-05') },
    { doc_entry: 102, doc_date: null },
  ];

  it('promedia OC − solicitud base, tomando la solicitud más antigua', () => {
    const result = sapGestionDays(
      [
        // 10 días desde la solicitud 100
        {
          doc_entry: 1,
          doc_date: d('2026-09-11'),
          base_request_entries: [100],
        },
        // dos solicitudes base: cuenta desde la más antigua (100) → 20 días
        {
          doc_entry: 2,
          doc_date: d('2026-09-21'),
          base_request_entries: [101, 100],
        },
      ],
      requests,
    );
    expect(result).toEqual({
      promedio_dias: 15,
      mediana_dias: 15,
      total: 2,
      descartadas: 0,
    });
  });

  it('ignora OC sin solicitud base y descarta negativas o sin fecha', () => {
    const result = sapGestionDays(
      [
        { doc_entry: 1, doc_date: d('2026-09-11'), base_request_entries: [] },
        // OC fechada ANTES que su solicitud: captura retroactiva, se descarta
        {
          doc_entry: 2,
          doc_date: d('2026-08-30'),
          base_request_entries: [100],
        },
        // solicitud base sin fecha
        {
          doc_entry: 3,
          doc_date: d('2026-09-30'),
          base_request_entries: [102],
        },
        // solicitud base no sincronizada
        {
          doc_entry: 4,
          doc_date: d('2026-09-30'),
          base_request_entries: [999],
        },
        {
          doc_entry: 5,
          doc_date: d('2026-09-08'),
          base_request_entries: [101],
        },
      ],
      requests,
    );
    expect(result).toEqual({
      promedio_dias: 3,
      mediana_dias: 3,
      total: 1,
      descartadas: 3,
    });
  });

  it('sin base devuelve null (nunca 0)', () => {
    expect(sapGestionDays([], requests)).toEqual({
      promedio_dias: null,
      mediana_dias: null,
      total: 0,
      descartadas: 0,
    });
  });

  it('redondea a 1 decimal', () => {
    const result = sapGestionDays(
      [
        {
          doc_entry: 1,
          doc_date: d('2026-09-02'),
          base_request_entries: [100],
        },
        {
          doc_entry: 2,
          doc_date: d('2026-09-03'),
          base_request_entries: [100],
        },
        {
          doc_entry: 3,
          doc_date: d('2026-09-03'),
          base_request_entries: [100],
        },
      ],
      requests,
    );
    expect(result.promedio_dias).toBe(1.7);
  });
});

describe('mediana y gestión de Maximo (G2, 2026-09-28)', () => {
  it('la mediana resiste a las OC capturadas meses después', () => {
    expect(averageAndMedian([5, 6, 7, 200])).toEqual({
      promedio_dias: 54.5,
      mediana_dias: 6.5,
    });
    expect(averageAndMedian([3, 1, 2])).toEqual({
      promedio_dias: 2,
      mediana_dias: 2,
    });
    expect(averageAndMedian([])).toEqual({
      promedio_dias: null,
      mediana_dias: null,
    });
  });

  it('Maximo: OC − PR.ISSUEDATE; sin solicitud y negativas quedan fuera y se cuentan', () => {
    expect(
      maximoGestionDays([
        { dias: 10 },
        { dias: '20.5' }, // numeric de Postgres llega como Decimal/string
        { dias: null }, // OC sin solicitud
        { dias: -3 }, // OC fechada antes que su PR
        { dias: 30 },
      ]),
    ).toEqual({
      promedio_dias: 20.2,
      mediana_dias: 20.5,
      total: 3,
      descartadas: 1,
      sin_solicitud: 1,
    });
  });
});

describe('gestionDays (H1: la misma cuenta por solicitud)', () => {
  it('días entre la solicitud y su OC; negativo (captura retroactiva) → null', () => {
    expect(gestionDays(d('2026-09-01'), d('2026-09-12'))).toBe(11);
    expect(gestionDays(new Date('2026-09-01T12:00:00Z'), d('2026-09-02'))).toBe(
      0.5,
    );
    expect(gestionDays(d('2026-09-12'), d('2026-09-01'))).toBeNull();
  });
});

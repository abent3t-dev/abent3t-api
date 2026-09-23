import { sapGestionDays } from './sap-gestion-days';

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
    expect(result).toEqual({ promedio_dias: 15, total: 2, descartadas: 0 });
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
    expect(result).toEqual({ promedio_dias: 3, total: 1, descartadas: 3 });
  });

  it('sin base devuelve null (nunca 0)', () => {
    expect(sapGestionDays([], requests)).toEqual({
      promedio_dias: null,
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

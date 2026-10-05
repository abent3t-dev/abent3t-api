import {
  compararSerie,
  conciliarAvance,
  HIPOTESIS_H2_COMPARA,
  hipotesisH2,
  MOTIVO_COPIA,
  type NuestraSemana,
  opcionesConciliacion,
  validezPagina,
} from './avance-semanal.conciliacion';
import type { AvanceData, Gestion } from './avance-semanal.engine';
import {
  AVANCE_MONTO_BASE,
  AVANCE_MONTOS_FUENTE_MAXIMO,
  AVANCE_REGLAS,
} from './avance-semanal.reglas';
import {
  JORGE,
  JORGE_ANUAL,
  JORGE_CIERRE_2025,
  JORGE_MONTOS,
  JORGE_MONTOS_TOTAL,
  type JorgeSemana,
  jorgeFor,
  jorgeSemanas,
} from './jorge-serie';

/**
 * K5.7 (2026-10-05) — conciliación de la página de Maximo contra la serie
 * de Jorge: validez por página con las identidades de su propia serie,
 * error ponderado y criterio, con series sintéticas (dev no tiene los datos
 * de prod).
 */

const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Lo nuestro igual a lo de Jorge (por `factor`), para probar el criterio. */
function sintetica(j: JorgeSemana, factor = 1): NuestraSemana {
  const x = (v: number | null) => (v === null ? 0 : v * factor);
  const dias = (v: number | null) => (v === null ? null : v * factor);
  return {
    recibidas: x(j.recibidas),
    nuevas: x(j.nuevas),
    cerradas_anio: x(j.medidor_cerradas ?? j.cerradas_anio),
    canceladas_anio: x(j.medidor_canceladas),
    abiertas: x(j.medidor_abiertas),
    cerradas_semana: x(j.cerradas_semana),
    dias_cierre_promedio: dias(j.dias_cierre),
    dias_cierre_mediana: dias(j.dias_cierre),
    dias_cancelacion: dias(j.dias_cancelacion),
    cerradas_sin_oc_ni_contrato: 0,
    cerradas_de_contrato: 0,
  };
}

const kpi = (
  semana: ReturnType<typeof compararSerie>['semanas'][number],
  nombre: string,
) => semana.kpis.find((k) => k.kpi === nombre)!;

describe('serie de Jorge', () => {
  it('38 páginas semanales (21-sep a 5-ene) y la p.39 aparte (cierre de 2025)', () => {
    const semanas = jorgeSemanas();
    expect(JORGE).toHaveLength(39);
    expect(semanas).toHaveLength(38);
    expect(semanas[0]).toMatchObject({
      pagina: 1,
      lunes: '2026-09-21',
      recibidas: 582,
      medidor_abiertas: 41,
    });
    expect(semanas[37]).toMatchObject({ pagina: 38, lunes: '2026-01-05' });
    expect(JORGE_CIERRE_2025).toEqual({
      anio: 2025,
      recibidas: 657,
      cerradas: 600,
      dias_cierre: 21,
      dias_cancelacion: 32,
    });
    // la p.39 no se compara al corte de una semana
    expect(jorgeFor(D('2025-12-29'))).toBeNull();
    expect(jorgeFor(D('2026-09-21'))?.pagina).toBe(1);
  });

  it('los montos mensuales suman el total que Jorge escribió (2025: un centavo de redondeo en su origen)', () => {
    const suma = (anio: number) =>
      Math.round(JORGE_MONTOS[anio].reduce((s, v) => s + v, 0) * 100) / 100;
    expect(suma(2026)).toBe(JORGE_MONTOS_TOTAL[2026]);
    expect(suma(2025)).toBe(254_915_373.07);
    expect(JORGE_MONTOS_TOTAL[2025]).toBe(254_915_373.06);
    expect(JORGE_MONTOS[2026]).toHaveLength(9);
    expect(JORGE_MONTOS[2025]).toHaveLength(12);
    expect(JORGE_ANUAL.find((a) => a.anio === 2025)?.nota).toContain(
      'No cuadra en su origen',
    );
  });
});

describe('validez por página (identidades de la propia serie)', () => {
  const semanas = jorgeSemanas();

  it('p.1: las tres identidades cuadran', () => {
    expect(validezPagina(semanas, 0)).toEqual({
      recibidas_nuevas: true,
      medidor: true,
      titular_cerradas: 'cerradas',
      // H15: no repite la semana anterior
      copia: false,
    });
  });

  it('p.16 con "777" canceladas: el medidor queda fuera; recibidas y titular sí cuentan', () => {
    const v = validezPagina(semanas, 15);
    expect(v.medidor).toBe(false);
    expect(v.recibidas_nuevas).toBe(true);
    expect(v.titular_cerradas).toBe('cerradas');
    const [s] = compararSerie(
      [semanas[15], semanas[16]],
      [sintetica(semanas[15]), sintetica(semanas[16])],
    ).semanas;
    expect(kpi(s, 'medidor_canceladas')).toMatchObject({
      jorge: 777,
      valida: false,
      motivo: 'el medidor no suma las recibidas',
    });
    expect(kpi(s, 'medidor_abiertas').valida).toBe(false);
    expect(kpi(s, 'recibidas').valida).toBe(true);
  });

  it('p.38 (primera semana del año) con 23 recibidas contra 19 nuevas: fuera de su KPI', () => {
    const v = validezPagina(semanas, 37);
    expect(v.recibidas_nuevas).toBe(false);
    const s = compararSerie(
      semanas,
      semanas.map((j) => sintetica(j)),
    ).semanas[37];
    expect(kpi(s, 'recibidas').valida).toBe(false);
    expect(kpi(s, 'nuevas').valida).toBe(false);
    // sin medidor en su archivo: el medidor no se compara
    expect(kpi(s, 'medidor_abiertas').motivo).toBe('Jorge no tiene el dato');
    // la p.37 sí cuadra: 44 − 23 = 21
    expect(validezPagina(semanas, 36).recibidas_nuevas).toBe(true);
  });

  it('p.27: el titular de cerradas = cerradas + canceladas (216 = 162 + 54) se compara contra nuestras cerradas + canceladas', () => {
    const v = validezPagina(semanas, 26);
    expect(v.titular_cerradas).toBe('atendidas');
    expect(v.copia).toBe(false);
    const nuestra = { ...sintetica(semanas[26]) };
    const s = compararSerie(
      [semanas[26], semanas[27]],
      [nuestra, sintetica(semanas[27])],
    ).semanas[0];
    expect(kpi(s, 'cerradas_anio')).toMatchObject({
      jorge: 216,
      nuestro: 216,
      valida: true,
    });
  });

  it('H15: la p.26 es copia de la p.27 (9 valores iguales) y no se compara en ningún KPI; la p.27 sí', () => {
    expect(semanas[25].lunes).toBe('2026-03-30');
    expect(validezPagina(semanas, 25).copia).toBe(true);
    // sus identidades internas cuadran: por eso pasaba
    expect(validezPagina(semanas, 25)).toMatchObject({
      medidor: true,
      titular_cerradas: 'atendidas',
    });
    expect(validezPagina(semanas, 26).copia).toBe(false);
    // ninguna otra página de la serie es copia
    expect(
      semanas
        .map((_, i) => (validezPagina(semanas, i).copia ? i + 1 : null))
        .filter((p) => p !== null),
    ).toEqual([26]);

    const r = compararSerie(
      semanas.slice(24, 28),
      semanas.slice(24, 28).map((j) => sintetica(j)),
    );
    const p26 = r.semanas.find((s) => s.pagina === 26)!;
    for (const k of p26.kpis) {
      expect(k.valida).toBe(false);
      expect(k.motivo).toBe(
        k.jorge === null ? 'Jorge no tiene el dato' : MOTIVO_COPIA,
      );
    }
    const p27 = r.semanas.find((s) => s.pagina === 27)!;
    expect(kpi(p27, 'atendidas').valida).toBe(true);
    expect(kpi(p27, 'medidor_abiertas').valida).toBe(true);
  });
});

describe('criterio con una serie sintética', () => {
  const semanas = jorgeSemanas();

  it('igual a la de Jorge: 0% de error en todos los KPI y cumple', () => {
    const r = compararSerie(
      semanas,
      semanas.map((j) => sintetica(j)),
    );
    for (const k of r.resumen) {
      expect(k.semanas).toBeGreaterThan(0);
      expect(k.error_pct).toBe(0);
      expect(k.error_absoluto_medio).toBe(0);
      expect(k.sesgo).toBe(0);
    }
    expect(r.criterio.cumple).toBe(true);
    expect(r.criterio.kpis.map((k) => k.kpi)).toEqual([
      'recibidas',
      'atendidas',
      'medidor_abiertas',
    ]);
    expect(r.criterio.abiertas_error_absoluto_medio).toBe(0);
  });

  it('con 10% de desfase: error 10%, sesgo positivo y no cumple', () => {
    const r = compararSerie(
      semanas,
      semanas.map((j) => sintetica(j, 1.1)),
    );
    const recibidas = r.resumen.find((k) => k.kpi === 'recibidas')!;
    expect(recibidas.error_pct).toBe(10);
    expect(recibidas.sesgo).toBeGreaterThan(0);
    expect(r.criterio.cumple).toBe(false);
    expect(r.criterio.kpis.every((k) => !k.cumple)).toBe(true);
    expect(r.criterio.abiertas_error_absoluto_medio).toBeGreaterThan(0);
  });

  it('el error es ponderado (Σ|dif| / Σ Jorge): el mismo desfase pesa igual en una semana chica que en una grande', () => {
    const base = semanas.map((j) => sintetica(j));
    const chica = base.map((n, i) =>
      i === 36 ? { ...n, recibidas: n.recibidas + 10 } : n,
    );
    const grande = base.map((n, i) =>
      i === 0 ? { ...n, recibidas: n.recibidas + 10 } : n,
    );
    const err = (serie: NuestraSemana[]) =>
      compararSerie(semanas, serie).resumen.find((k) => k.kpi === 'recibidas')!;
    // +10 sobre 44 sería 23% y sobre 582, 1.7%: no se promedian porcentajes
    expect(err(chica).error_pct).toBe(err(grande).error_pct);
    expect(err(chica).error_absoluto_medio).toBe(
      err(grande).error_absoluto_medio,
    );
  });
});

describe('H2: cerradas de contrato contra las canceladas del año de Jorge', () => {
  const semanas = jorgeSemanas();
  // semanas donde se comparan las canceladas del medidor de Jorge
  const validas = compararSerie(
    semanas,
    semanas.map((j) => sintetica(j)),
  ).semanas.filter((s) => kpi(s, 'medidor_canceladas').valida);
  const conContrato = (desfase: number) =>
    semanas.map((j) => ({
      ...sintetica(j),
      cerradas_de_contrato: (j.medidor_canceladas ?? 0) + desfase,
    }));

  it('cada semana lleva sus cerradas de contrato; iguales a las canceladas de Jorge dan 0% en las semanas con medidor válido', () => {
    const r = compararSerie(semanas, conContrato(0));
    expect(r.semanas[0].cerradas_de_contrato).toBe(
      semanas[0].medidor_canceladas,
    );
    expect(hipotesisH2(r.semanas)).toEqual({
      compara: HIPOTESIS_H2_COMPARA,
      semanas: validas.length,
      error_pct: 0,
      error_absoluto_medio: 0,
      sesgo: 0,
    });
    // fuera: la p.16 (medidor con "777"), la p.26 (copia) y la p.38 (sin medidor)
    const paginas = validas.map((s) => s.pagina);
    expect(paginas.length).toBeGreaterThan(20);
    expect(paginas).not.toContain(16);
    expect(paginas).not.toContain(26);
    expect(paginas).not.toContain(38);
  });

  it('con desfase: el mismo error ponderado, error absoluto medio y sesgo que el resumen', () => {
    const h2 = hipotesisH2(compararSerie(semanas, conContrato(2)).semanas);
    expect(h2.error_absoluto_medio).toBe(2);
    expect(h2.sesgo).toBe(2);
    const sumaJorge = validas.reduce(
      (s, v) => s + (kpi(v, 'medidor_canceladas').jorge ?? 0),
      0,
    );
    expect(h2.error_pct).toBe(
      Math.round(((2 * validas.length) / sumaJorge) * 10_000) / 100,
    );
    // la misma cuenta que el resumen de medidor_canceladas con ese desfase
    const resumen = compararSerie(
      semanas,
      semanas.map((j) => ({
        ...sintetica(j),
        canceladas_anio: (j.medidor_canceladas ?? 0) + 2,
      })),
    ).resumen.find((k) => k.kpi === 'medidor_canceladas')!;
    expect(h2).toMatchObject({
      semanas: resumen.semanas,
      error_pct: resumen.error_pct,
      error_absoluto_medio: resumen.error_absoluto_medio,
      sesgo: resumen.sesgo,
    });
  });

  it('sin semanas válidas: todo null', () => {
    expect(hipotesisH2([])).toEqual({
      compara: HIPOTESIS_H2_COMPARA,
      semanas: 0,
      error_pct: null,
      error_absoluto_medio: null,
      sesgo: null,
    });
  });
});

describe('conciliarAvance', () => {
  const gestion = (overrides: Partial<Gestion>): Gestion => ({
    sistema: 'maximo',
    folio: 'PR1',
    recibida: new Date('2026-09-15T15:00:00Z'),
    fecha_origen: 'aprobacion',
    inicio_dias: new Date('2026-09-15T15:00:00Z'),
    primera_oc: null,
    cierre_sin_oc: null,
    cancelada: null,
    de_contrato: false,
    ...overrides,
  });
  const data: AvanceData = {
    gestiones: [
      gestion({ primera_oc: new Date('2026-09-24T16:00:00Z') }),
      gestion({
        folio: 'PR2',
        cierre_sin_oc: new Date('2026-09-25T16:00:00Z'),
      }),
      gestion({ folio: 'PR3', recibida: new Date('2025-03-10T15:00:00Z') }),
    ],
    ordenes: [
      {
        sistema: 'maximo',
        fecha: new Date('2026-03-10T15:00:00Z'),
        moneda: 'MXN',
        monto: 116,
        subtotal: 100,
        contada_en_maximo: false,
      },
      {
        sistema: 'sap',
        fecha: D('2026-03-11'),
        moneda: 'MXN',
        monto: 232,
        subtotal: 200,
        contada_en_maximo: true,
      },
      {
        sistema: 'maximo',
        fecha: new Date('2025-02-10T15:00:00Z'),
        moneda: 'USD',
        monto: 11.6,
        subtotal: null,
        contada_en_maximo: false,
      },
    ],
    maximo_no_recibidas: [],
    sap_desde: null,
  };

  it('las 38 semanas al corte de cada una, H1, montos por fuente y base, anual y cierre de 2025', () => {
    const conc = conciliarAvance(
      data,
      opcionesConciliacion({}),
      new Date('2026-10-05T18:00:00Z'),
    );
    expect(conc.semanas).toHaveLength(38);
    expect(kpi(conc.semanas[0], 'recibidas')).toMatchObject({
      jorge: 582,
      nuestro: 2,
    });
    expect(conc.semanas[0].cerradas_sin_oc_ni_contrato).toBe(1);
    // una semana antes, todavía no cerraban
    expect(kpi(conc.semanas[1], 'cerradas_anio').nuestro).toBe(0);
    const [m2026, m2025] = conc.montos;
    expect(m2026.meses[2].nuestro).toEqual({
      maximo_con_iva: 116,
      maximo_sin_iva: 100,
      sap_migradas_con_iva: 232,
      sap_migradas_sin_iva: 200,
    });
    expect(m2026.total.jorge).toBeCloseTo(94_670_099.15, 2);
    expect(m2026.total.jorge_escrito).toBe(94_670_099.15);
    expect(m2025.meses).toHaveLength(12);
    expect(m2025.sin_subtotal.maximo).toBe(1);
    expect(m2025.otras_monedas.maximo_con_iva).toEqual({ USD: 11.6 });
    expect(conc.anual.find((a) => a.anio === 2026)).toMatchObject({
      jorge: { recibidas: 582, atendidas: 541 },
      nuestro: { recibidas: 2, atendidas: 2 },
    });
    expect(conc.anual.find((a) => a.anio === 2025)?.nuestro.recibidas).toBe(1);
    expect(conc.cierre_2025.nuestro).toMatchObject({
      recibidas: 1,
      abiertas: 1,
    });
    expect(conc.maximo).toEqual({ gestiones: 3, no_recibidas: 0 });
  });

  it('opciones: lo que no viene toma el default', () => {
    expect(opcionesConciliacion({})).toEqual({
      reglas: AVANCE_REGLAS,
      monto_base: AVANCE_MONTO_BASE,
      montos_fuente_maximo: AVANCE_MONTOS_FUENTE_MAXIMO,
    });
    expect(
      opcionesConciliacion({ dias_desde: 'emision', montos: 'sap_migradas' }),
    ).toEqual({
      reglas: { ...AVANCE_REGLAS, dias_desde: 'emision' },
      monto_base: AVANCE_MONTO_BASE,
      montos_fuente_maximo: 'sap_migradas',
    });
  });

  it('H3: dias_tipo respeta lo pedido y por default son días naturales', () => {
    expect(opcionesConciliacion({}).reglas.dias_tipo).toBe('naturales');
    expect(opcionesConciliacion({ dias_tipo: 'habiles' })).toEqual({
      reglas: { ...AVANCE_REGLAS, dias_tipo: 'habiles' },
      monto_base: AVANCE_MONTO_BASE,
      montos_fuente_maximo: AVANCE_MONTOS_FUENTE_MAXIMO,
    });
  });

  it('H2: cada semana lleva sus cerradas de contrato al corte y la respuesta trae las hipótesis', () => {
    const conContrato: AvanceData = {
      ...data,
      gestiones: [
        ...data.gestiones,
        // de contrato, cerrada con OC el 24-sep
        gestion({
          folio: 'PR4',
          primera_oc: new Date('2026-09-24T16:00:00Z'),
          de_contrato: true,
        }),
        // de contrato, cerrada por CLOSE el 16-sep (no es H1)
        gestion({
          folio: 'PR5',
          cierre_sin_oc: new Date('2026-09-16T16:00:00Z'),
          de_contrato: true,
        }),
        // de contrato, abierta
        gestion({ folio: 'PR6', de_contrato: true }),
      ],
    };
    const conc = conciliarAvance(
      conContrato,
      opcionesConciliacion({}),
      new Date('2026-10-05T18:00:00Z'),
    );
    expect(conc.semanas[0]).toMatchObject({
      lunes: '2026-09-21',
      cerradas_de_contrato: 2,
      cerradas_sin_oc_ni_contrato: 1,
    });
    expect(conc.semanas[1]).toMatchObject({
      lunes: '2026-09-14',
      cerradas_de_contrato: 1,
    });
    expect(conc.semanas[2].cerradas_de_contrato).toBe(0);
    expect(conc.hipotesis.h2).toMatchObject({ compara: HIPOTESIS_H2_COMPARA });
    expect(conc.hipotesis.h2.semanas).toBeGreaterThan(0);
    // 2 o menos contra las canceladas de Jorge: contamos de menos
    expect(conc.hipotesis.h2.sesgo).toBeLessThan(0);
    expect(conc.hipotesis.h3).toContain('dias_tipo=habiles');
  });

  it('H3: con dias_tipo=habiles los días de cierre salen en hábiles y la respuesta lo reporta', () => {
    const generado = new Date('2026-10-05T18:00:00Z');
    const naturales = conciliarAvance(data, opcionesConciliacion({}), generado);
    const habiles = conciliarAvance(
      data,
      opcionesConciliacion({ dias_tipo: 'habiles' }),
      generado,
    );
    expect(habiles.opciones.reglas.dias_tipo).toBe('habiles');
    expect(naturales.opciones.reglas.dias_tipo).toBe('naturales');
    // martes 15-sep 09:00 a jueves 24-sep 10:00 de México: 9 días y 1 h
    // naturales; 6 días hábiles enteros + 15 h + 10 h
    expect(kpi(naturales.semanas[0], 'dias_cierre_promedio').nuestro).toBe(9);
    expect(kpi(habiles.semanas[0], 'dias_cierre_promedio').nuestro).toBe(7);
    expect(habiles.hipotesis.h3).toContain('cuenta días hábiles');
    // los conteos no cambian
    expect(kpi(habiles.semanas[0], 'recibidas').nuestro).toBe(
      kpi(naturales.semanas[0], 'recibidas').nuestro,
    );
  });
});

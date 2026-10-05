/**
 * H1 (2026-09-29) / K5.7 (2026-10-05) — Conciliación del "Reporte de avance
 * semanal" contra el que Jorge armaba a mano, para dev: envoltura de la
 * misma función que el endpoint de super_admin
 * (`GET /compras/reportes/avance-semanal/conciliacion`, `conciliarAvance`).
 * La serie de Jorge vive en src/purchase-reports/avance-semanal/jorge-serie.ts.
 * Solo lectura.
 *
 * USO:
 *   npm run avance:check                          (criterio y resumen con los defaults + la última semana completa)
 *   npm run avance:check -- --semana=2026-09-21   (KPI de una semana por fuente vs Jorge)
 *   npm run avance:check -- --serie               (las 38 semanas: Jorge vs nuestra página de Maximo)
 *   npm run avance:check -- --recibida=emision --dias_desde=emision --montos=sap_migradas --corte=viernes
 *   npm run avance:check -- --json=conciliacion.json  (la respuesta completa, como el endpoint)
 *   npm run avance:check -- --pdf=avance.pdf      (guarda el PDF de la semana)
 *   npm run avance:check -- --acumulado=acum.pdf  (PDF del año y cuánto tarda)
 *
 * I3 (2026-09-30): los PDF salen como en Reportes — `--fuente=ambos` (default:
 * Maximo y luego SAP), `maximo`, `sap` o `todas`.
 */
import { writeFileSync } from 'fs';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  conciliarAvance,
  opcionesConciliacion,
} from '../src/purchase-reports/avance-semanal/avance-semanal.conciliacion';
import {
  buildAvanceData,
  loadAvanceRows,
} from '../src/purchase-reports/avance-semanal/avance-semanal.data';
import {
  AVANCE_FUENTES,
  type AvanceData,
  type AvancePage,
  type AvanceReporte,
  buildAvancePage,
  firstMondayOfYear,
  fuentesDelReporte,
  isoDay,
  lastCompleteWeek,
  mondayOf,
  parseDay,
  weeksBetween,
} from '../src/purchase-reports/avance-semanal/avance-semanal.engine';
import { renderAvancePdf } from '../src/purchase-reports/avance-semanal/avance-semanal.pdf';
import {
  AVANCE_CORTES,
  AVANCE_INICIOS,
  AVANCE_MONTOS_FUENTES,
  type AvanceCorte,
  type AvanceInicio,
  type AvanceMontosFuente,
  type AvanceOpciones,
  montoBaseTexto,
} from '../src/purchase-reports/avance-semanal/avance-semanal.reglas';
import { jorgeFor } from '../src/purchase-reports/avance-semanal/jorge-serie';

function arg(name: string): string | undefined {
  const hit = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`),
  );
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
}

/** Argumento con valores fijos (los mismos que el DTO del endpoint). */
function choice<T extends string>(name: string, values: T[]): T | undefined {
  const value = arg(name);
  if (value === undefined) return undefined;
  if (!values.includes(value as T)) {
    throw new Error(`--${name} debe ser ${values.join(' | ')}`);
  }
  return value as T;
}

const dias = (v: number | null) => (v === null ? '—' : String(v));
const cell = (v: string | number | null | undefined, w = 14) =>
  String(v ?? '—').padStart(w);
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

function weekTable(data: AvanceData, lunes: Date, opciones: AvanceOpciones) {
  const now = new Date();
  const pages = AVANCE_FUENTES.map((f) =>
    buildAvancePage(data, lunes, f, now, opciones),
  );
  const j = jorgeFor(lunes);
  console.log(
    `\n${pages[0].semana.etiqueta} (lunes ${isoDay(lunes)}, corte ${pages[0].semana.corte_dia} ${pages[0].semana.corte})`,
  );
  console.log(
    `${'KPI'.padEnd(34)}${cell('Jorge')}${AVANCE_FUENTES.map((f) => cell(f)).join('')}`,
  );
  const rows: Array<
    [
      string,
      number | null | undefined,
      (p: AvancePage) => string | number | null,
    ]
  > = [
    ['Recibidas del año', j?.recibidas, (p) => p.avance.recibidas_anio],
    ['Nuevas en la semana', j?.nuevas, (p) => p.avance.nuevas_semana],
    ['Cerradas del año', j?.cerradas_anio, (p) => p.avance.cerradas_anio],
    [
      'Cerradas en la semana',
      j?.cerradas_semana,
      (p) => p.avance.cerradas_semana,
    ],
    [
      'Días de cierre del año (prom.)',
      j?.dias_cierre,
      (p) => dias(p.cierre.anio.promedio_dias),
    ],
    [
      'Días de cierre del año (mediana)',
      j?.dias_cierre,
      (p) => dias(p.cierre.anio.mediana_dias),
    ],
    [
      'Días de cancelación (prom.)',
      j?.dias_cancelacion,
      (p) => dias(p.cancelacion.anio?.promedio_dias ?? null),
    ],
    [
      'Canceladas del año',
      j?.medidor_canceladas,
      (p) => p.estado_anio.canceladas,
    ],
    ['Abiertas del año', j?.medidor_abiertas, (p) => p.estado_anio.abiertas],
    [
      'Cerradas sin OC ni contrato (H1)',
      null,
      (p) => p.estado_anio.cerradas_sin_oc_ni_contrato,
    ],
    [
      'PR emitidas sin aprobar (aparte)',
      null,
      (p) => p.avance.maximo_no_recibidas ?? '—',
    ],
    ['% atendidas del año', null, (p) => p.estado_anio.atendidas_pct],
  ];
  for (const [label, jorge, pick] of rows) {
    console.log(
      `${label.padEnd(34)}${cell(jorge)}${pages.map((p) => cell(pick(p))).join('')}`,
    );
  }
  console.log('\nPor año (recibidas / atendidas / %), fuente todas:');
  for (const c of pages[0].anual) {
    console.log(
      `  ${c.anio}: ${c.recibidas} / ${c.atendidas} / ${c.atendidas_pct ?? '—'}%  (cerradas ${c.cerradas}, canceladas ${c.canceladas}, abiertas ${c.abiertas})`,
    );
  }
  const maximo = pages[1];
  console.log(
    `\nMontos del año por mes, página de Maximo, MXN ${montoBaseTexto(maximo.montos.base)} (otro valor: ${montoBaseTexto(maximo.montos.otro.base)}):`,
  );
  for (const mes of maximo.montos.meses) {
    const mx = (v: number | undefined) =>
      v === undefined
        ? '—'
        : v.toLocaleString('es-MX', { maximumFractionDigits: 0 });
    console.log(
      `  ${mes.etiqueta.padEnd(11)}${mx(mes.montos.MXN).padStart(16)}`,
    );
  }
  console.log(
    `  sin subtotal: ${maximo.montos.sin_subtotal.ordenes} OC · ${montoBaseTexto(maximo.montos.otro.base)}: ${JSON.stringify(maximo.montos.otro.total)}`,
  );
}

async function main(): Promise<void> {
  const opciones = opcionesConciliacion({
    recibida: choice<AvanceInicio>('recibida', AVANCE_INICIOS),
    dias_desde: choice<AvanceInicio>('dias_desde', AVANCE_INICIOS),
    montos: choice<AvanceMontosFuente>('montos', AVANCE_MONTOS_FUENTES),
    corte: choice<AvanceCorte>('corte', AVANCE_CORTES),
  });
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const t0 = Date.now();
    const data = buildAvanceData(await loadAvanceRows(prisma), opciones.reglas);
    const maximoN = data.gestiones.filter((g) => g.sistema === 'maximo').length;
    console.log(
      `Reglas: ${JSON.stringify(opciones.reglas)} · montos ${opciones.monto_base} de ${opciones.montos_fuente_maximo}`,
    );
    console.log(
      `Datos: ${data.gestiones.length} gestiones (SAP ${data.gestiones.length - maximoN}, Maximo ${maximoN}; PR de Maximo fuera del universo: ${data.maximo_no_recibidas.length}), ${data.ordenes.length} OC · ${Date.now() - t0} ms`,
    );
    const semana = arg('semana');
    const lunes = semana ? mondayOf(parseDay(semana)) : lastCompleteWeek();
    weekTable(data, lunes, opciones);

    const t1 = Date.now();
    const conc = conciliarAvance(data, opciones, new Date());
    console.log(
      `\nConciliación contra Jorge (38 semanas, página de Maximo) · ${Date.now() - t1} ms`,
    );
    console.log(
      `${'KPI'.padEnd(24)}${cell('semanas', 9)}${cell('error')}${cell('abs. medio')}${cell('sesgo')}`,
    );
    for (const r of conc.resumen) {
      console.log(
        `${r.kpi.padEnd(24)}${cell(r.semanas, 9)}${cell(pct(r.error_pct))}${cell(r.error_absoluto_medio)}${cell(r.sesgo)}`,
      );
    }
    console.log(
      `\nCriterio (error ≤${conc.criterio.umbral_pct}%): ${conc.criterio.kpis
        .map((k) => `${k.kpi} ${pct(k.error_pct)} ${k.cumple ? 'sí' : 'no'}`)
        .join(
          ' · ',
        )} → cumple: ${conc.criterio.cumple ? 'SÍ' : 'NO'} · abiertas, error absoluto medio: ${conc.criterio.abiertas_error_absoluto_medio ?? '—'} PR`,
    );
    for (const m of conc.montos) {
      console.log(
        `\nMontos ${m.anio} MXN (Jorge ${m.total.jorge.toLocaleString('es-MX')}; escrito ${m.total.jorge_escrito?.toLocaleString('es-MX') ?? '—'}):`,
      );
      for (const [variante, total] of Object.entries(m.total.nuestro)) {
        console.log(
          `  ${variante.padEnd(22)}${cell(total === null ? '—' : total.toLocaleString('es-MX'), 18)}  error por mes ${pct(m.error_pct[variante as keyof typeof m.error_pct])}`,
        );
      }
    }
    console.log(
      '\nAnual (al corte de la p.1): Jorge vs nuestro, recibidas / atendidas',
    );
    for (const a of conc.anual) {
      console.log(
        `  ${a.anio}: ${a.jorge.recibidas} / ${a.jorge.atendidas}  vs  ${a.nuestro.recibidas} / ${a.nuestro.atendidas}${a.nota ? `  (${a.nota})` : ''}`,
      );
    }

    if (arg('serie') !== undefined) {
      console.log(
        '\nSerie por semana (Jorge → nuestro; * = no se compara por su identidad o falta dato):',
      );
      const kpis = [
        'recibidas',
        'nuevas',
        'cerradas_anio',
        'cerradas_semana',
        'atendidas',
        'medidor_abiertas',
      ];
      for (const s of conc.semanas) {
        const partes = s.kpis
          .filter((k) => kpis.includes(k.kpi))
          .map(
            (k) =>
              `${k.kpi} ${k.jorge ?? '—'}→${k.nuestro ?? '—'}${k.valida ? '' : '*'}`,
          );
        // H15: la página copiada de la anterior no se compara en ningún KPI
        console.log(
          `  p.${String(s.pagina).padStart(2)} ${s.lunes}  ${partes.join(' · ')} · H1 ${s.cerradas_sin_oc_ni_contrato}${s.validez.copia ? ' · copia de la semana anterior: no se compara' : ''}`,
        );
      }
    }

    const json = arg('json');
    if (json) {
      writeFileSync(json, JSON.stringify(conc, null, 2));
      console.log(`\nConciliación completa: ${json}`);
    }

    const reporte = (arg('fuente') as AvanceReporte | undefined) ?? 'ambos';
    const fuentes = fuentesDelReporte(reporte);
    const pdf = arg('pdf');
    if (pdf) {
      const now = new Date();
      const buffer = await renderAvancePdf(
        fuentes.map((f) => buildAvancePage(data, lunes, f, now, opciones)),
      );
      writeFileSync(pdf, buffer);
      console.log(
        `\nPDF de la semana: ${pdf} · ${fuentes.length} páginas (${reporte}) · ${buffer.length} bytes`,
      );
    }
    const acumulado = arg('acumulado');
    if (acumulado) {
      const t2 = Date.now();
      const again = buildAvanceData(
        await loadAvanceRows(prisma),
        opciones.reglas,
      );
      const weeks = weeksBetween(
        firstMondayOfYear(lunes.getUTCFullYear()),
        lunes,
      );
      const now = new Date();
      const pages = fuentes.flatMap((f) =>
        weeks.map((w) => buildAvancePage(again, w, f, now, opciones)),
      );
      const buffer = await renderAvancePdf(pages);
      writeFileSync(acumulado, buffer);
      console.log(
        `PDF acumulado: ${acumulado} · ${pages.length} páginas (${weeks.length} semanas × ${fuentes.length}, ${reporte}) · ${buffer.length} bytes · ${Date.now() - t2} ms (con la carga de datos)`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('avance:check falló:', err);
  process.exitCode = 1;
});

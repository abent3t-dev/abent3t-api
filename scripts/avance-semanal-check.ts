/**
 * H1 (2026-09-29) — Conciliación del "Reporte de avance semanal" contra el
 * que Jorge arma a mano (documentation/Reporte_Semanal_20260925.pdf; su
 * serie de KPIs va abajo, tal cual, con sus errores de captura). Solo lectura.
 *
 * USO:
 *   npm run avance:check                          (última semana completa)
 *   npm run avance:check -- --semana=2026-09-21   (una semana: KPI por fuente vs Jorge)
 *   npm run avance:check -- --serie               (las 39 semanas de Jorge, fuente maximo y todas)
 *   npm run avance:check -- --pdf=avance.pdf      (guarda el PDF de la semana)
 *   npm run avance:check -- --acumulado=acum.pdf  (PDF del año y cuánto tarda)
 *
 * I3 (2026-09-30): los PDF salen como en Reportes — `--fuente=ambos` (default:
 * Maximo y luego SAP), `maximo`, `sap` o `todas`.
 */
import { writeFileSync } from 'fs';
import { PrismaService } from '../src/prisma/prisma.service';
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

const DAY_MS = 86_400_000;

/**
 * Serie de Jorge (Reporte_Semanal_Jorge_series_2026.csv): página 1 = semana
 * del 21-sep-2026 y cada página es la semana anterior. Columnas: recibidas
 * del año, nuevas de la semana, cerradas del año, cerradas de la semana,
 * días de cierre (año), días de cancelación (año), y del medidor del año:
 * cerradas, canceladas, abiertas. null = vacío en su archivo.
 */
const JORGE: Array<Array<number | null>> = [
  [582, 14, 415, 7, 11, 7, 415, 126, 41],
  [568, 16, 410, 8, 11, 7, 410, 122, 36],
  [552, 6, 402, 12, 11, 6, 402, 118, 32],
  [546, 13, 391, 20, null, 7, 391, 116, 36],
  [533, 16, 370, 17, 10, 7, 370, 110, 53],
  [517, 17, 354, 13, 10, 5, 354, 105, 58],
  [500, 11, 341, 11, 10, 5, 341, 98, 61],
  [489, 16, 330, 10, 10, 5, 330, 98, 61],
  [473, 13, 322, 9, 10, 4, 322, 90, 61],
  [460, 8, 311, 13, 10, 5, 311, 88, 61],
  [452, 24, 298, 10, 9, 5, 298, 86, 68],
  [428, 30, 287, 20, 10, 5, 287, 83, 58],
  [398, 14, 267, 6, 9, 4, 267, 80, 51],
  [384, 10, 261, 6, 9, 5, 261, 79, 44],
  [374, 9, 254, 8, 9, 5, 254, 79, 41],
  [365, 15, 243, 16, 8, 5, 243, 777, 45],
  [350, 13, 234, 6, 4, 6, 234, 74, 42],
  [337, 8, 228, 6, 8, 6, 228, 72, 37],
  [329, 9, 224, 10, 9, 6, 224, 72, 33],
  [320, 11, 216, 8, 9, 6, 216, 69, 35],
  [309, 7, 208, 5, 9, 7, 208, 69, 32],
  [302, 11, 204, 4, 9, 7, 204, 69, 29],
  [291, 15, 199, 10, 9, 7, 199, 66, 26],
  [276, 8, 189, 11, 9, 6, 189, 60, 27],
  [268, 15, 237, 10, 9, 6, 162, 54, 33],
  [249, 12, 216, 11, 9, 7, 162, 54, 33],
  [249, 12, 216, 11, 9, 7, 162, 54, 33],
  [237, 11, 203, 9, 9, 8, 149, 54, 34],
  [77, 226, 176, 4, 9, 8, 140, 52, 34],
  [77, 203, 172, 16, 9, 9, 135, 48, 20],
  [158, 199, 140, 37, 9, 9, 134, 44, 21],
  [158, 36, 120, 14, 11, 11, 92, 34, 32],
  [122, 27, 107, 20, 11, 13, 84, 23, 15],
  [95, 18, 86, 15, 11, 13, 67, 20, 8],
  [77, 15, 71, 30, 12, 16, null, null, null],
  [62, 18, 41, 15, 15, 17, null, null, null],
  [44, 21, 26, 12, 17, 23, null, null, null],
  [23, 19, 14, 14, 21, 32, null, null, null],
  [657, 0, 600, 1, 21, 32, null, null, null],
];
const JORGE_LATEST = Date.UTC(2026, 8, 21);

function jorgeFor(lunes: Date): Array<number | null> | null {
  const page = Math.round((JORGE_LATEST - lunes.getTime()) / (7 * DAY_MS));
  return JORGE[page] ?? null;
}

function arg(name: string): string | undefined {
  const hit = process.argv.find(
    (a) => a === `--${name}` || a.startsWith(`--${name}=`),
  );
  if (!hit) return undefined;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
}

const dias = (v: number | null) => (v === null ? '—' : String(v));
const cell = (v: unknown, w = 14) => String(v ?? '—').padStart(w);

function weekTable(data: AvanceData, lunes: Date) {
  const now = new Date();
  const pages = AVANCE_FUENTES.map((f) => buildAvancePage(data, lunes, f, now));
  const j = jorgeFor(lunes);
  console.log(
    `\n${pages[0].semana.etiqueta} (lunes ${isoDay(lunes)}, corte ${pages[0].semana.domingo})`,
  );
  console.log(
    `${'KPI'.padEnd(34)}${cell('Jorge')}${AVANCE_FUENTES.map((f) => cell(f)).join('')}`,
  );
  const rows: Array<
    [string, number | null | undefined, (p: AvancePage) => unknown]
  > = [
    ['Recibidas del año', j?.[0], (p) => p.avance.recibidas_anio],
    ['Nuevas en la semana', j?.[1], (p) => p.avance.nuevas_semana],
    ['  con fecha aproximada', null, (p) => p.avance.nuevas_aproximadas],
    ['Cerradas del año', j?.[2], (p) => p.avance.cerradas_anio],
    ['Cerradas en la semana', j?.[3], (p) => p.avance.cerradas_semana],
    [
      'Días de cierre del año (prom.)',
      j?.[4],
      (p) => dias(p.cierre.anio.promedio_dias),
    ],
    [
      'Días de cierre del año (mediana)',
      null,
      (p) => dias(p.cierre.anio.mediana_dias),
    ],
    [
      'Días de cancelación (prom.)',
      j?.[5],
      (p) =>
        p.cancelacion.anio
          ? dias(p.cancelacion.anio.promedio_dias)
          : 'No disp.',
    ],
    [
      'Canceladas del año',
      j?.[7],
      (p) =>
        p.fuente.clave === 'maximo' ? 'No disp.' : p.estado_anio.canceladas,
    ],
    ['Abiertas del año (SAP)', j?.[8], (p) => p.estado_anio.abiertas],
    ['Sin OC del año (Maximo)', null, (p) => p.estado_anio.sin_oc],
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
      `  ${c.anio}: ${c.recibidas} / ${c.atendidas} / ${c.atendidas_pct ?? '—'}%  (cerradas ${c.cerradas}, canceladas ${c.canceladas}, abiertas ${c.abiertas}, sin OC ${c.sin_oc})`,
    );
  }
  console.log('\nMontos del año por mes (todas · maximo), MXN con IVA:');
  const [todas, maximo] = [pages[0], pages[1]];
  for (const [i, mes] of todas.montos.meses.entries()) {
    const mx = (m: AvancePage['montos']['meses'][number] | undefined) =>
      (m?.montos.MXN ?? 0).toLocaleString('es-MX', {
        maximumFractionDigits: 0,
      });
    console.log(
      `  ${mes.etiqueta.padEnd(11)}${mx(mes).padStart(16)}${mx(maximo.montos.meses[i]).padStart(16)}`,
    );
  }
}

function serie(data: AvanceData) {
  const now = new Date();
  console.log(
    '\nSerie por semana: Jorge vs maximo vs todas (recibidas del año · nuevas · cerradas del año · cerradas de la semana)',
  );
  for (let page = 0; page < JORGE.length; page += 1) {
    const lunes = new Date(JORGE_LATEST - page * 7 * DAY_MS);
    const j = JORGE[page];
    const [mx, all] = (['maximo', 'todas'] as const).map((f) =>
      buildAvancePage(data, lunes, f, now),
    );
    const fmt = (p: AvancePage) =>
      `${p.avance.recibidas_anio}·${p.avance.nuevas_semana}·${p.avance.cerradas_anio}·${p.avance.cerradas_semana}`;
    console.log(
      `  ${isoDay(lunes)}  Jorge ${j
        .slice(0, 4)
        .map((v) => v ?? '—')
        .join('·')
        .padEnd(18)} maximo ${fmt(mx).padEnd(18)} todas ${fmt(all)}`,
    );
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const t0 = Date.now();
    const data = buildAvanceData(await loadAvanceRows(prisma));
    console.log(
      `Datos: ${data.gestiones.length} gestiones (SAP ${data.gestiones.filter((g) => g.sistema === 'sap').length}, Maximo ${data.gestiones.filter((g) => g.sistema === 'maximo').length}; Maximo aproximadas: ${data.gestiones.filter((g) => g.fecha_origen !== 'exacta').length}, sin fecha: ${data.maximo_sin_fecha}), ${data.ordenes.length} OC · ${Date.now() - t0} ms`,
    );
    const semana = arg('semana');
    const lunes = semana ? mondayOf(parseDay(semana)) : lastCompleteWeek();
    weekTable(data, lunes);
    if (arg('serie') !== undefined) serie(data);
    const reporte = (arg('fuente') as AvanceReporte | undefined) ?? 'ambos';
    const fuentes = fuentesDelReporte(reporte);
    const pdf = arg('pdf');
    if (pdf) {
      const now = new Date();
      const buffer = await renderAvancePdf(
        fuentes.map((f) => buildAvancePage(data, lunes, f, now)),
      );
      writeFileSync(pdf, buffer);
      console.log(
        `\nPDF de la semana: ${pdf} · ${fuentes.length} páginas (${reporte}) · ${buffer.length} bytes`,
      );
    }
    const acumulado = arg('acumulado');
    if (acumulado) {
      const t1 = Date.now();
      const again = buildAvanceData(await loadAvanceRows(prisma));
      const weeks = weeksBetween(
        firstMondayOfYear(lunes.getUTCFullYear()),
        lunes,
      );
      const now = new Date();
      const pages = fuentes.flatMap((f) =>
        weeks.map((w) => buildAvancePage(again, w, f, now)),
      );
      const buffer = await renderAvancePdf(pages);
      writeFileSync(acumulado, buffer);
      console.log(
        `PDF acumulado: ${acumulado} · ${pages.length} páginas (${weeks.length} semanas × ${fuentes.length}, ${reporte}) · ${buffer.length} bytes · ${Date.now() - t1} ms (con la carga de datos)`,
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

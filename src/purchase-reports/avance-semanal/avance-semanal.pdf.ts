import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import type { AvancePage, DiasStats } from './avance-semanal.engine';
import {
  LOGO_A3T_PNG,
  POPPINS_BOLD,
  POPPINS_REGULAR,
  POPPINS_SEMIBOLD,
} from './pdf-assets';

/**
 * H1 — PDF del "Reporte de avance semanal": una página carta horizontal por
 * semana con las 9 secciones del reporte de Jorge y el look de la plataforma
 * (tarjetas blancas, verde de marca). Todo vectorial con pdfkit (JS puro):
 * sin Chromium ni LibreOffice en la imagen del api.
 */

type Doc = PDFKit.PDFDocument;

const W = 792;
const H = 612;
const M = 22;

const C = {
  verde: '#52AF32',
  verdeOscuro: '#2E7D1F',
  verdeClaro: '#8CCB6E',
  verdeFondo: '#EEF6EA',
  gris: '#424846',
  grisTexto: '#6B7280',
  grisSuave: '#9CA3AF',
  track: '#E5E7EB',
  borde: '#DDE2DD',
  fondo: '#F5F7F5',
  marino: '#222D59',
  dorado: '#DFA922',
  blanco: '#FFFFFF',
};

const F = { r: 'Poppins', s: 'Poppins-SemiBold', b: 'Poppins-Bold' };

const MES3 = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

const DAY_MS = 86_400_000;

// Decodificados una vez por proceso
let fonts: { regular: Buffer; semibold: Buffer; bold: Buffer } | null = null;

function loadFonts() {
  fonts ??= {
    regular: Buffer.from(POPPINS_REGULAR, 'base64'),
    semibold: Buffer.from(POPPINS_SEMIBOLD, 'base64'),
    bold: Buffer.from(POPPINS_BOLD, 'base64'),
  };
  return fonts;
}

/** Como texto: pdfkit registra la imagen una vez por documento, no por página. */
const LOGO_URI = `data:image/png;base64,${LOGO_A3T_PNG}`;

// ── Formato ─────────────────────────────────────────────────────────────

const fmtInt = (n: number) => n.toLocaleString('es-MX');

const fmtMoney = (n: number) =>
  n.toLocaleString('es-MX', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** 10.9 → "10.9"; 11 → "11"; null → "—". */
const fmtDias = (v: number | null) =>
  v === null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(1);

const fmtPct = (v: number | null) =>
  v === null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(1)}%`;

/** Lunes ISO → "4 sep" (su viernes), para las tablas de 4 semanas. */
function viernesCorto(lunes: string): string {
  const v = new Date(Date.parse(`${lunes}T00:00:00Z`) + 4 * DAY_MS);
  return `${v.getUTCDate()} ${MES3[v.getUTCMonth()]}`;
}

function generadoTexto(iso: string): string {
  return new Date(iso).toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// ── Primitivas ──────────────────────────────────────────────────────────

interface TextOpts {
  font?: string;
  size?: number;
  color?: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  height?: number;
  lineGap?: number;
}

function text(doc: Doc, s: string, x: number, y: number, o: TextOpts = {}) {
  doc
    .font(o.font ?? F.r)
    .fontSize(o.size ?? 8)
    .fillColor(o.color ?? C.gris)
    .text(s, x, y, {
      width: o.width,
      align: o.align ?? 'left',
      height: o.height,
      ellipsis: o.height !== undefined,
      lineGap: o.lineGap ?? 0,
      lineBreak: o.width !== undefined,
    });
}

function card(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  h: number,
  title: string,
  subtitle?: string | null,
): number {
  doc.save();
  doc.lineWidth(0.8);
  doc.roundedRect(x, y, w, h, 7).fillAndStroke(C.blanco, C.borde);
  doc.restore();
  doc.rect(x + 12, y + 12, 3, 12).fill(C.verde);
  text(doc, title, x + 20, y + 10, {
    font: F.s,
    size: 9.5,
    width: w - 32,
    height: 30,
  });
  let top =
    y + 10 + Math.min(30, doc.heightOfString(title, { width: w - 32 })) + 1;
  if (subtitle) {
    text(doc, subtitle, x + 20, top, {
      size: 6.8,
      color: C.grisTexto,
      width: w - 32,
      height: 22,
    });
    doc.font(F.r).fontSize(6.8);
    top += Math.min(22, doc.heightOfString(subtitle, { width: w - 32 })) + 1;
  }
  return top + 5;
}

/** Sector de anillo; ángulos en radianes desde las 12 en sentido horario. */
function ring(
  doc: Doc,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  from: number,
  to: number,
  color: string,
) {
  if (to - from <= 1e-6) return;
  if (to - from >= 2 * Math.PI - 1e-6) {
    ring(doc, cx, cy, inner, outer, from, from + Math.PI, color);
    ring(doc, cx, cy, inner, outer, from + Math.PI, to, color);
    return;
  }
  const at = (r: number, a: number) =>
    `${(cx + r * Math.cos(a - Math.PI / 2)).toFixed(2)} ${(cy + r * Math.sin(a - Math.PI / 2)).toFixed(2)}`;
  const large = to - from > Math.PI ? 1 : 0;
  doc
    .path(
      `M ${at(outer, from)} A ${outer} ${outer} 0 ${large} 1 ${at(outer, to)} ` +
        `L ${at(inner, to)} A ${inner} ${inner} 0 ${large} 0 ${at(inner, from)} Z`,
    )
    .fill(color);
}

// ── Secciones ───────────────────────────────────────────────────────────

function header(doc: Doc, page: AvancePage) {
  const grad = doc.linearGradient(0, 0, W, 0);
  grad.stop(0, C.verde).stop(0.65, '#3F9A2A').stop(1, C.verdeOscuro);
  doc.rect(0, 0, W, 74).fill(grad);
  text(doc, 'Reporte de avance semanal', M, 11, {
    font: F.b,
    size: 24,
    color: C.blanco,
  });
  text(doc, page.semana.etiqueta, M, 45, {
    size: 12.5,
    color: C.blanco,
  });
  const boxW = 150;
  const boxX = W - M - boxW;
  doc.roundedRect(boxX, 11, boxW, 52, 8).fill(C.blanco);
  doc.image(LOGO_URI, boxX + 12, 17, {
    fit: [boxW - 24, 40],
    align: 'center',
    valign: 'center',
  });
  text(
    doc,
    `Fuente: ${page.fuente.etiqueta}   ·   Datos al domingo ${page.semana.corte}   ·   Generado el ${generadoTexto(page.generado)} (hora del centro)`,
    M,
    80,
    { size: 7.5, color: C.grisTexto, width: W - 2 * M },
  );
}

function kpiRow(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  value: string,
  label: string,
  sub?: string,
) {
  text(doc, value, x, y, {
    font: F.b,
    size: 19,
    color: C.verdeOscuro,
    width: 60,
    align: 'right',
  });
  text(doc, label, x + 66, y + 3, { size: 8, width: w - 66, height: 26 });
  if (sub) {
    doc.font(F.r).fontSize(8);
    const h = Math.min(26, doc.heightOfString(label, { width: w - 66 }));
    text(doc, sub, x + 66, y + 3 + h, {
      size: 6.8,
      color: C.grisTexto,
      width: w - 66,
      height: 21,
    });
  }
}

function porFuente(
  page: AvancePage,
  pick: (s: NonNullable<AvancePage['por_sistema']['sap']>) => number,
): string | undefined {
  const { sap, maximo } = page.por_sistema;
  if (!sap || !maximo) return undefined;
  return `SAP ${fmtInt(pick(sap))} · Maximo ${fmtInt(pick(maximo))}`;
}

function avanceCard(
  doc: Doc,
  page: AvancePage,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  let top = card(doc, x, y, w, h, 'Avance semanal de gestiones');
  const a = page.avance;
  const anio = page.semana.anio;
  const viernes = viernesCorto(page.semana.lunes);
  const rows: Array<[string, string, string | undefined]> = [
    [
      fmtInt(a.recibidas_anio),
      `gestiones recibidas en ${anio} al ${viernes}`,
      porFuente(page, (s) => s.recibidas_anio),
    ],
    [
      fmtInt(a.nuevas_semana),
      'gestiones nuevas recibidas en la semana',
      [
        porFuente(page, (s) => s.nuevas_semana),
        a.nuevas_aproximadas > 0
          ? `${fmtInt(a.nuevas_aproximadas)} aprox.`
          : undefined,
      ]
        .filter(Boolean)
        .join(' · ') || undefined,
    ],
    [
      fmtInt(a.cerradas_anio),
      `cerradas de las recibidas en ${anio}`,
      porFuente(page, (s) => s.cerradas_anio),
    ],
    [
      fmtInt(a.cerradas_semana),
      'gestiones cerradas en la semana',
      porFuente(page, (s) => s.cerradas_semana),
    ],
  ];
  // En enero, abajo: lo que sigue sin atender del año anterior (como Jorge)
  const footerH = a.anio_anterior ? 24 : 0;
  const rowH = (y + h - top - footerH - 6) / rows.length;
  for (const [value, label, sub] of rows) {
    kpiRow(doc, x + 8, top, w - 16, value, label, sub);
    top += rowH;
  }
  if (a.anio_anterior) {
    const prev = a.anio_anterior;
    const partes = [
      page.fuente.clave !== 'maximo'
        ? `${fmtInt(prev.abiertas)} abiertas`
        : null,
      page.fuente.clave !== 'sap'
        ? `${fmtInt(prev.sin_oc)} sin OC (Maximo)`
        : null,
    ].filter(Boolean);
    const boxY = y + h - footerH - 8;
    doc.roundedRect(x + 10, boxY, w - 20, footerH, 5).fill(C.verdeFondo);
    text(doc, `De ${prev.anio}: ${partes.join(' · ')}`, x + 16, boxY + 7, {
      font: F.s,
      size: 7,
      color: C.gris,
      width: w - 32,
      height: 12,
    });
  }
}

function weeksTable(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  rows: Array<{ lunes: string; n: number; dias: DiasStats }>,
  eventLabel: string,
) {
  const cols = [
    { label: 'Semana al', w: 0.3, align: 'left' as const },
    { label: 'Prom.', w: 0.21, align: 'right' as const },
    { label: 'Mediana', w: 0.21, align: 'right' as const },
    { label: eventLabel, w: 0.28, align: 'right' as const },
  ];
  let cx = x;
  for (const c of cols) {
    text(doc, c.label, cx, y, {
      size: 6.5,
      color: C.grisTexto,
      width: c.w * w - 2,
      align: c.align,
    });
    cx += c.w * w;
  }
  doc
    .moveTo(x, y + 10)
    .lineTo(x + w, y + 10)
    .lineWidth(0.5)
    .strokeColor(C.borde)
    .stroke();
  let ry = y + 13;
  for (const r of rows) {
    const values = [
      viernesCorto(r.lunes),
      r.dias.total === 0 ? '—' : `${fmtDias(r.dias.promedio_dias)} d`,
      r.dias.total === 0 ? '—' : `${fmtDias(r.dias.mediana_dias)} d`,
      fmtInt(r.n),
    ];
    cx = x;
    values.forEach((v, i) => {
      text(doc, v, cx, ry, {
        font: i === 1 ? F.s : F.r,
        size: 7.8,
        width: cols[i].w * w - 2,
        align: cols[i].align,
      });
      cx += cols[i].w * w;
    });
    ry += 14;
  }
}

function diasCard(
  doc: Doc,
  x: number,
  y: number,
  w: number,
  h: number,
  opts: {
    title: string;
    subtitle: string | null;
    anio: DiasStats | null;
    anioLabel: string;
    eventLabel: string;
    /** Qué cuenta la N del promedio ("cerradas con OC de 2026"). */
    nLabel: string;
    semanas: Array<{ lunes: string; n: number; dias: DiasStats }>;
    noDisponible?: string | null;
  },
) {
  const top = card(doc, x, y, w, h, opts.title, opts.subtitle);
  if (opts.noDisponible || !opts.anio) {
    doc.roundedRect(x + 12, top + 6, w - 24, 60, 6).fill(C.fondo);
    text(doc, 'No disponible', x + 20, top + 14, {
      font: F.s,
      size: 11,
      color: C.grisTexto,
      width: w - 40,
    });
    // la nota del motor dice "No disponible: …"; aquí ya va de título
    const motivo = (opts.noDisponible ?? '').replace(/^No disponible:\s*/, '');
    text(doc, motivo, x + 20, top + 32, {
      size: 7.2,
      color: C.grisTexto,
      width: w - 40,
      height: 30,
    });
    return;
  }
  const a = opts.anio;
  if (a.total === 0) {
    text(
      doc,
      `Sin ${opts.eventLabel.toLowerCase()} en ${opts.anioLabel}`,
      x + 14,
      top + 4,
      {
        font: F.s,
        size: 11,
        color: C.grisTexto,
        width: w - 28,
      },
    );
  } else {
    text(doc, fmtDias(a.promedio_dias), x + 14, top, {
      font: F.b,
      size: 28,
      color: C.verdeOscuro,
    });
    doc.font(F.b).fontSize(28);
    const numW = doc.widthOfString(fmtDias(a.promedio_dias));
    text(doc, 'días promedio', x + 18 + numW, top + 13, {
      font: F.s,
      size: 9,
      width: w - numW - 32,
    });
    text(
      doc,
      `Mediana ${fmtDias(a.mediana_dias)} días · sobre ${fmtInt(a.total)} ${opts.nLabel}`,
      x + 14,
      top + 38,
      { size: 7.3, color: C.grisTexto, width: w - 28, height: 24 },
    );
  }
  weeksTable(doc, x + 14, top + 68, w - 28, opts.semanas, opts.eventLabel);
}

const ESTADOS = [
  { key: 'cerradas', label: 'Cerradas', color: C.verde },
  { key: 'canceladas', label: 'Canceladas', color: C.grisSuave },
  { key: 'abiertas', label: 'Abiertas', color: C.dorado },
  { key: 'sin_oc', label: 'Sin OC (Maximo)', color: C.marino },
] as const;

function donaCard(
  doc: Doc,
  page: AvancePage,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const e = page.estado_anio;
  const top = card(doc, x, y, w, h, `Recibidas ${page.semana.anio} por estado`);
  const cx = x + w / 2;
  const cy = top + 58;
  const total = e.recibidas;
  const items = ESTADOS.filter((s) =>
    s.key === 'abiertas'
      ? page.fuente.clave !== 'maximo'
      : s.key === 'sin_oc'
        ? page.fuente.clave !== 'sap'
        : s.key === 'canceladas'
          ? page.fuente.clave !== 'maximo'
          : true,
  );
  if (total === 0) {
    ring(doc, cx, cy, 34, 52, 0, 2 * Math.PI, C.track);
  } else {
    let angle = 0;
    for (const s of items) {
      const value = e[s.key];
      const sweep = (value / total) * 2 * Math.PI;
      ring(doc, cx, cy, 34, 52, angle, angle + sweep, s.color);
      angle += sweep;
    }
  }
  text(doc, fmtPct(e.atendidas_pct), cx - 32, cy - 12, {
    font: F.b,
    size: 15,
    color: C.gris,
    width: 64,
    align: 'center',
  });
  text(doc, 'atendidas', cx - 32, cy + 6, {
    size: 6.8,
    color: C.grisTexto,
    width: 64,
    align: 'center',
  });
  let ly = cy + 62;
  for (const s of items) {
    const value = e[s.key];
    const pct = total === 0 ? 0 : Math.round((value / total) * 1000) / 10;
    doc.roundedRect(x + 14, ly + 2, 7, 7, 1.5).fill(s.color);
    text(doc, s.label, x + 25, ly, { size: 7.5, width: w - 90 });
    text(doc, `${fmtInt(value)} · ${fmtPct(pct)}`, x + w - 72, ly, {
      font: F.s,
      size: 7.5,
      width: 58,
      align: 'right',
    });
    ly += 13;
  }
}

function banda(doc: Doc, y: number) {
  const grad = doc.linearGradient(M, 0, W - M, 0);
  grad.stop(0, C.verdeOscuro).stop(0.5, C.verde).stop(1, C.verdeOscuro);
  doc.roundedRect(M, y, W - 2 * M, 22, 6).fill(grad);
  text(
    doc,
    'Comparación anual: gestiones recibidas contra atendidas (cerradas + canceladas)',
    M,
    y + 5,
    {
      font: F.s,
      size: 9.5,
      color: C.blanco,
      width: W - 2 * M,
      align: 'center',
    },
  );
}

const GAUGE_COLORS = ['#2E7D1F', '#3F9A2A', '#52AF32', '#74B82B'];

function medidoresCard(
  doc: Doc,
  page: AvancePage,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const top = card(
    doc,
    x,
    y,
    w,
    h,
    'Evolución de gestiones atendidas',
    '% atendido por año de recepción, al cierre de la semana',
  );
  const years = page.anual.slice(-4);
  const cellW = (w - 16) / 2;
  const cellH = (y + h - top - 4) / 2;
  years.forEach((c, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = x + 8 + col * cellW + cellW / 2;
    const cy = top + row * cellH + 34;
    ring(doc, cx, cy, 20, 30, -Math.PI / 2, Math.PI / 2, C.track);
    const pct = c.atendidas_pct ?? 0;
    ring(
      doc,
      cx,
      cy,
      20,
      30,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * Math.min(1, pct / 100),
      GAUGE_COLORS[i] ?? C.verde,
    );
    text(
      doc,
      c.recibidas === 0 ? '—' : fmtPct(c.atendidas_pct),
      cx - 26,
      cy - 13,
      {
        font: F.b,
        size: 10,
        width: 52,
        align: 'center',
      },
    );
    text(doc, String(c.anio), cx - 26, cy + 1, {
      font: F.s,
      size: 8,
      color: C.grisTexto,
      width: 52,
      align: 'center',
    });
    const detalle =
      c.recibidas === 0
        ? 'Sin gestiones'
        : page.fuente.clave === 'maximo'
          ? // Maximo no manda canceladas: solo cerradas y sin OC
            `${fmtInt(c.cerradas)} cerradas\n${fmtInt(c.sin_oc)} sin OC`
          : [
              `${fmtInt(c.cerradas)} cerradas · ${fmtInt(c.canceladas)} canceladas`,
              [
                `${fmtInt(c.abiertas)} abiertas`,
                page.fuente.clave !== 'sap'
                  ? `${fmtInt(c.sin_oc)} sin OC`
                  : null,
              ]
                .filter(Boolean)
                .join(' · '),
            ].join('\n');
    text(doc, detalle, cx - cellW / 2 + 2, cy + 12, {
      size: 6.3,
      color: C.grisTexto,
      width: cellW - 4,
      align: 'center',
      height: 20,
    });
  });
}

function montosCard(
  doc: Doc,
  page: AvancePage,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const m = page.montos;
  const top = card(
    doc,
    x,
    y,
    w,
    h,
    `Montos adjudicados ${m.anio}`,
    'OC no canceladas, con IVA, por mes de la OC',
  );
  if (m.ordenes === 0) {
    text(doc, 'Sin OC en el año.', x + 14, top + 6, {
      size: 8,
      color: C.grisTexto,
      width: w - 28,
    });
    return;
  }
  const tableCur = m.monedas.filter((c) => c === 'MXN' || c === 'USD');
  const shown = tableCur.length > 0 ? tableCur : m.monedas.slice(0, 1);
  const extra = m.monedas.filter((c) => !shown.includes(c));
  const tx = x + 10;
  const tw = w - 20;
  const mesW = 58;
  const curW = (tw - mesW) / shown.length;
  const rows = m.meses.length + 2;
  const avail = y + h - top - (extra.length > 0 ? 18 : 8);
  const rowH = Math.min(13, avail / rows);
  const size = rowH >= 12 ? 7.8 : 7;
  let ry = top;
  doc.rect(tx, ry, tw, rowH).fill(C.verde);
  text(doc, 'Mes', tx + 4, ry + (rowH - size) / 2 - 1, {
    font: F.s,
    size,
    color: C.blanco,
    width: mesW - 4,
  });
  shown.forEach((cur, i) => {
    text(
      doc,
      cur === 'MXN' ? '$ MXN' : cur,
      tx + mesW + i * curW,
      ry + (rowH - size) / 2 - 1,
      {
        font: F.s,
        size,
        color: C.blanco,
        width: curW - 4,
        align: 'right',
      },
    );
  });
  ry += rowH;
  m.meses.forEach((mes, idx) => {
    if (idx % 2 === 0) doc.rect(tx, ry, tw, rowH).fill(C.verdeFondo);
    text(doc, mes.etiqueta, tx + 4, ry + (rowH - size) / 2 - 1, {
      size,
      width: mesW - 4,
    });
    shown.forEach((cur, i) => {
      const v = mes.montos[cur];
      text(
        doc,
        v === undefined ? '—' : fmtMoney(v),
        tx + mesW + i * curW,
        ry + (rowH - size) / 2 - 1,
        {
          size,
          color: v === undefined ? C.grisSuave : C.gris,
          width: curW - 4,
          align: 'right',
        },
      );
    });
    ry += rowH;
  });
  doc
    .moveTo(tx, ry)
    .lineTo(tx + tw, ry)
    .lineWidth(0.8)
    .strokeColor(C.verde)
    .stroke();
  text(doc, 'Total', tx + 4, ry + (rowH - size) / 2 - 1, {
    font: F.b,
    size,
    width: mesW - 4,
  });
  shown.forEach((cur, i) => {
    text(
      doc,
      fmtMoney(m.total[cur] ?? 0),
      tx + mesW + i * curW,
      ry + (rowH - size) / 2 - 1,
      {
        font: F.b,
        size,
        width: curW - 4,
        align: 'right',
      },
    );
  });
  ry += rowH + 3;
  if (extra.length > 0) {
    text(
      doc,
      `Además: ${extra.map((c) => `${c} ${fmtMoney(m.total[c] ?? 0)}`).join(' · ')} (sin convertir)`,
      tx,
      ry,
      { size: 6.5, color: C.grisTexto, width: tw, height: 14 },
    );
  }
}

function barrasCard(
  doc: Doc,
  page: AvancePage,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const top = card(doc, x, y, w, h, 'Recibidas contra atendidas por año');
  const legend = [
    { label: 'Recibidas', color: C.verdeOscuro },
    { label: 'Atendidas', color: C.verdeClaro },
  ];
  let lx = x + 20;
  for (const l of legend) {
    doc.roundedRect(lx, top + 1, 7, 7, 1.5).fill(l.color);
    text(doc, l.label, lx + 10, top - 1, { size: 7.2, color: C.grisTexto });
    lx += 62;
  }
  const chartX = x + 14;
  const chartW = w - 28;
  const chartTop = top + 22;
  const chartBottom = y + h - 20;
  const chartH = chartBottom - chartTop;
  const years = page.anual;
  const max = Math.max(1, ...years.flatMap((c) => [c.recibidas, c.atendidas]));
  const groupW = chartW / years.length;
  const barW = Math.min(18, groupW / 2 - 5);
  doc
    .moveTo(chartX, chartBottom)
    .lineTo(chartX + chartW, chartBottom)
    .lineWidth(0.6)
    .strokeColor(C.borde)
    .stroke();
  years.forEach((c, i) => {
    const gx = chartX + i * groupW + groupW / 2;
    const bars = [
      { v: c.recibidas, color: C.verdeOscuro, bx: gx - barW - 1.5 },
      { v: c.atendidas, color: C.verdeClaro, bx: gx + 1.5 },
    ];
    for (const b of bars) {
      const bh = (b.v / max) * (chartH - 12);
      if (bh > 0) doc.rect(b.bx, chartBottom - bh, barW, bh).fill(b.color);
      text(doc, fmtInt(b.v), b.bx - 8, chartBottom - bh - 10, {
        size: 6.8,
        color: C.gris,
        width: barW + 16,
        align: 'center',
      });
    }
    text(doc, String(c.anio), gx - groupW / 2, chartBottom + 4, {
      font: F.s,
      size: 7.8,
      color: C.grisTexto,
      width: groupW,
      align: 'center',
    });
  });
}

function footer(doc: Doc, page: AvancePage, index: number, total: number) {
  const notas = page.notas.join('  ·  ');
  text(doc, notas, M, 562, {
    size: 6.3,
    color: C.grisTexto,
    width: W - 2 * M - 70,
    height: 40,
    lineGap: 0.5,
  });
  text(doc, `Página ${index + 1} de ${total}`, W - M - 64, 590, {
    size: 7,
    color: C.grisTexto,
    width: 64,
    align: 'right',
  });
}

function drawPage(doc: Doc, page: AvancePage, index: number, total: number) {
  doc.rect(0, 0, W, H).fill(C.fondo);
  header(doc, page);

  const upperY = 96;
  const upperH = 222;
  const widths = [196, 180, 180, 162];
  const xs = widths.map(
    (_, i) => M + widths.slice(0, i).reduce((s, v) => s + v, 0) + i * 10,
  );
  avanceCard(doc, page, xs[0], upperY, widths[0], upperH);
  diasCard(doc, xs[1], upperY, widths[1], upperH, {
    title: 'Tiempo de cierre de gestiones',
    subtitle: 'De la solicitud a su primera OC',
    anio: page.cierre.anio,
    anioLabel: String(page.semana.anio),
    eventLabel: 'Cerradas',
    nLabel: `cerradas con OC de ${page.semana.anio}`,
    semanas: page.cierre.semanas.map((s) => ({
      lunes: s.lunes,
      n: s.cerradas,
      dias: s.dias,
    })),
  });
  diasCard(doc, xs[2], upperY, widths[2], upperH, {
    title: 'Tiempo de cancelación',
    subtitle: page.cancelacion.disponible
      ? (page.cancelacion.nota ?? 'De la solicitud a su cancelación')
      : null,
    anio: page.cancelacion.anio,
    anioLabel: String(page.semana.anio),
    eventLabel: 'Canceladas',
    nLabel: `canceladas de ${page.semana.anio}`,
    semanas: page.cancelacion.semanas.map((s) => ({
      lunes: s.lunes,
      n: s.canceladas,
      dias: s.dias,
    })),
    noDisponible: page.cancelacion.disponible ? null : page.cancelacion.nota,
  });
  donaCard(doc, page, xs[3], upperY, widths[3], upperH);

  banda(doc, 326);

  const lowerY = 356;
  const lowerH = 198;
  medidoresCard(doc, page, M, lowerY, 232, lowerH);
  montosCard(doc, page, M + 242, lowerY, 228, lowerH);
  barrasCard(doc, page, M + 480, lowerY, 268, lowerH);

  footer(doc, page, index, total);
}

/** Una página por elemento de `pages` (en ese orden). */
export function renderAvancePdf(pages: AvancePage[]): Promise<Buffer> {
  const { regular, semibold, bold } = loadFonts();
  return new Promise((resolve, reject) => {
    const first = pages[0];
    const doc = new PDFDocument({
      autoFirstPage: false,
      size: 'LETTER',
      layout: 'landscape',
      margin: 0,
      info: {
        Title:
          pages.length === 1 && first
            ? `Reporte de avance semanal — ${first.semana.etiqueta}`
            : 'Reporte de avance semanal — acumulado',
        Author: 'Abent 3T · Compras',
        Creator: 'Plataforma Abent 3T',
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont(F.r, regular);
    doc.registerFont(F.s, semibold);
    doc.registerFont(F.b, bold);
    pages.forEach((page, i) => {
      doc.addPage({ size: 'LETTER', layout: 'landscape', margin: 0 });
      drawPage(doc, page, i, pages.length);
    });
    doc.end();
  });
}

export function sendPdf(res: Response, buffer: Buffer, filename: string) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

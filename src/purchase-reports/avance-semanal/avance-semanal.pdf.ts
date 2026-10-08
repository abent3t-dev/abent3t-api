import PDFDocument from 'pdfkit';
import type { Response } from 'express';
import type {
  AvancePage,
  DiasStats,
  GrupoClave,
  GruposConteo,
} from './avance-semanal.engine';
import { montoBaseTexto } from './avance-semanal.reglas';
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
 *
 * I3 (2026-09-30): el sistema de la página va junto al título (Maximo / SAP)
 * y los marcadores del PDF agrupan las semanas por sistema (el índice del
 * acumulado, sin páginas extra).
 *
 * K5 (2026-10-05): la página de Maximo con el mismo formato que la de SAP
 * (cerradas · canceladas · abiertas, días de cancelación con dato), sin
 * fechas aproximadas ni "sin OC"; los montos dicen su base y el otro valor
 * va en una línea chica. H3: con `reglas.dias_tipo='habiles'`, las
 * tarjetas de días dicen "días hábiles" (`cierre.unidad`).
 *
 * L2 (2026-10-08, vista previa): si la página trae `grupos` (Maximo con
 * `grupos=contrato`), la dona, los medidores y las barras muestran "De
 * contrato (OC automática)" y "Canceladas en Maximo" aparte de las cerradas y
 * las abiertas. Sin `grupos`, la página se dibuja igual que antes.
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
  const titulo = 'Reporte de avance semanal';
  text(doc, titulo, M, 11, {
    font: F.b,
    size: 24,
    color: C.blanco,
  });
  // I3: cada página dice de qué sistema es
  doc.font(F.b).fontSize(24);
  const pillX = M + doc.widthOfString(titulo) + 12;
  doc.font(F.b).fontSize(14);
  const pillW = doc.widthOfString(page.fuente.etiqueta) + 22;
  doc.roundedRect(pillX, 15, pillW, 26, 13).fill(C.blanco);
  text(doc, page.fuente.etiqueta, pillX, 19.5, {
    font: F.b,
    size: 14,
    color: C.verdeOscuro,
    width: pillW,
    align: 'center',
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
    `Fuente: ${page.fuente.etiqueta}   ·   Datos al ${page.semana.corte_dia} ${page.semana.corte}   ·   Generado el ${generadoTexto(page.generado)} (hora del centro)`,
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
  // K5: las PR de Maximo emitidas sin aprobar no son recibidas; se dicen
  const noRecibidas =
    a.maximo_no_recibidas && page.opciones.reglas.recibida === 'aprobacion'
      ? `${fmtInt(a.maximo_no_recibidas)} ${a.maximo_no_recibidas === 1 ? 'PR emitida sin aprobar va' : 'PR emitidas sin aprobar van'} aparte`
      : undefined;
  const rows: Array<[string, string, string | undefined]> = [
    [
      fmtInt(a.recibidas_anio),
      `gestiones recibidas en ${anio} al ${viernes}`,
      [porFuente(page, (s) => s.recibidas_anio), noRecibidas]
        .filter(Boolean)
        .join(' · ') || undefined,
    ],
    [
      fmtInt(a.nuevas_semana),
      'gestiones nuevas recibidas en la semana',
      porFuente(page, (s) => s.nuevas_semana),
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
    const boxY = y + h - footerH - 8;
    doc.roundedRect(x + 10, boxY, w - 20, footerH, 5).fill(C.verdeFondo);
    text(
      doc,
      `De ${prev.anio}: ${fmtInt(prev.abiertas)} abiertas`,
      x + 16,
      boxY + 7,
      {
        font: F.s,
        size: 7,
        color: C.gris,
        width: w - 32,
        height: 12,
      },
    );
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
    /** H3: "días" o "días hábiles" (`reglas.dias_tipo`). */
    unidad: string;
    semanas: Array<{ lunes: string; n: number; dias: DiasStats }>;
  },
) {
  const top = card(doc, x, y, w, h, opts.title, opts.subtitle);
  const a = opts.anio ?? { promedio_dias: null, mediana_dias: null, total: 0 };
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
    const label = `${opts.unidad} promedio`;
    const labelW = w - numW - 32;
    // H3: "días hábiles promedio" junto a un promedio de dos cifras va en dos
    // renglones; se sube para no encimarse con la mediana (top + 38)
    doc.font(F.s).fontSize(9);
    const dosRenglones =
      doc.heightOfString(label, { width: labelW, lineGap: 0 }) > 14;
    text(doc, label, x + 18 + numW, top + (dosRenglones ? 5 : 13), {
      font: F.s,
      size: 9,
      width: labelW,
    });
    text(
      doc,
      `Mediana ${fmtDias(a.mediana_dias)} ${opts.unidad} · sobre ${fmtInt(a.total)} ${opts.nLabel}`,
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
] as const;

/**
 * L2: color de cada grupo (los de la dona de siempre; las de contrato en el
 * marino de la marca), igual en la dona, los medidores y las barras.
 */
const GRUPO_COLOR: Record<GrupoClave, string> = {
  cerradas_sin_contrato: C.verde,
  de_contrato: C.marino,
  canceladas: C.grisSuave,
  abiertas: C.dorado,
};

/** Una rebanada de la dona y su renglón en la leyenda. */
interface Rebanada {
  label: string;
  color: string;
  value: number;
  /** % de las recibidas, con un decimal. */
  pct: number;
}

/**
 * Geometría de la dona (radios, centro y leyenda desde el `top` de la
 * tarjeta). L2: con cuatro grupos es más chica para que quepan tres
 * etiquetas largas en dos renglones.
 */
const DONA = { inner: 34, outer: 52, centro: 58, leyenda: 62 };
const DONA_GRUPOS = { inner: 30, outer: 46, centro: 50, leyenda: 56 };

function rebanadas(page: AvancePage): Rebanada[] {
  if (page.grupos) {
    return page.grupos.estado_anio.grupos.map((g) => ({
      label: g.etiqueta,
      color: GRUPO_COLOR[g.clave],
      value: g.valor,
      pct: g.pct ?? 0,
    }));
  }
  // K5: las mismas tres en todas las fuentes (Maximo ya trae la CAN)
  const e = page.estado_anio;
  return ESTADOS.map((s) => ({
    label: s.label,
    color: s.color,
    value: e[s.key],
    pct:
      e.recibidas === 0 ? 0 : Math.round((e[s.key] / e.recibidas) * 1000) / 10,
  }));
}

/**
 * L2: la etiqueta en uno o dos renglones: si no cabe en `ancho`, se corta
 * antes del paréntesis ("De contrato" / "(OC automática)") o en el primer
 * espacio ("Cerradas" / "sin contrato", "Canceladas" / "en Maximo").
 */
function renglones(
  doc: Doc,
  label: string,
  ancho: number,
  size: number,
): [string] | [string, string] {
  doc.font(F.r).fontSize(size);
  if (doc.widthOfString(label) <= ancho) return [label];
  const parentesis = label.indexOf(' (');
  const corte = parentesis > 0 ? parentesis : label.indexOf(' ');
  return corte > 0 ? [label.slice(0, corte), label.slice(corte + 1)] : [label];
}

/**
 * L2: los grupos de un año en renglones, con su nombre dentro de la frase y
 * sin el paréntesis, como en la banda ("385 cerradas sin contrato", "121 de
 * contrato", "56 canceladas en Maximo", "44 abiertas"): "121 de contrato (OC
 * automática)" no cabe en un renglón del medidor (pdfkit también cuenta el
 * salto de línea en el ancho).
 */
const gruposEnRenglones = (c: GruposConteo) =>
  c.grupos
    .map((g) => {
      const nombre = g.etiqueta.replace(/ \(.*\)$/, '');
      return `${fmtInt(g.valor)} ${nombre.charAt(0).toLowerCase()}${nombre.slice(1)}`;
    })
    .join('\n');

/**
 * Geometría de cada medidor (radios, centro desde la celda y el detalle
 * debajo). L2: con grupos, el detalle lleva cuatro renglones más juntos y el
 * arco es un poco más chico para que no se encime con el de abajo. El tope
 * de alto (36) deja que pdfkit no corte con "…": con `lineGap` negativo, el
 * penúltimo renglón pide espacio para dos renglones completos (35 pt).
 */
const MEDIDOR = { inner: 20, outer: 30, centro: 34, detalle: 12, alto: 20 };
const MEDIDOR_GRUPOS = {
  inner: 18,
  outer: 27,
  centro: 30,
  detalle: 11,
  alto: 36,
  lineGap: -1.4,
};

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
  const geo = page.grupos ? DONA_GRUPOS : DONA;
  const cx = x + w / 2;
  const cy = top + geo.centro;
  const total = e.recibidas;
  const items = rebanadas(page);
  if (total === 0) {
    ring(doc, cx, cy, geo.inner, geo.outer, 0, 2 * Math.PI, C.track);
  } else {
    let angle = 0;
    for (const s of items) {
      const sweep = (s.value / total) * 2 * Math.PI;
      ring(doc, cx, cy, geo.inner, geo.outer, angle, angle + sweep, s.color);
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
  let ly = cy + geo.leyenda;
  const labelW = w - 90;
  for (const s of items) {
    // L2: "De contrato (OC automática)" y "Canceladas en Maximo" no caben
    // junto al valor: el resto de la etiqueta baja un renglón
    const [linea, resto] = page.grupos
      ? renglones(doc, s.label, labelW, 7.5)
      : [s.label];
    doc.roundedRect(x + 14, ly + 2, 7, 7, 1.5).fill(s.color);
    text(doc, linea, x + 25, ly, { size: 7.5, width: labelW });
    text(doc, `${fmtInt(s.value)} · ${fmtPct(s.pct)}`, x + w - 72, ly, {
      font: F.s,
      size: 7.5,
      width: 58,
      align: 'right',
    });
    if (resto) {
      ly += 10;
      text(doc, resto, x + 25, ly, { size: 7.5, width: labelW });
    }
    ly += 13;
  }
}

/** Leyenda de la banda: qué suman las atendidas (L2: por grupo). */
const BANDA = {
  estandar:
    'Comparación anual: gestiones recibidas contra atendidas (cerradas + canceladas)',
  grupos:
    'Comparación anual: gestiones recibidas contra atendidas (cerradas sin contrato + de contrato + canceladas en Maximo)',
};

function banda(doc: Doc, y: number, texto: string = BANDA.estandar) {
  const grad = doc.linearGradient(M, 0, W - M, 0);
  grad.stop(0, C.verdeOscuro).stop(0.5, C.verde).stop(1, C.verdeOscuro);
  doc.roundedRect(M, y, W - 2 * M, 22, 6).fill(grad);
  text(doc, texto, M, y + 5, {
    font: F.s,
    size: 9.5,
    color: C.blanco,
    width: W - 2 * M,
    align: 'center',
  });
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
  // L2: los mismos años por grupo (mismo orden que `anual`)
  const porGrupo = page.grupos?.anual.slice(-4);
  const cellW = (w - 16) / 2;
  const cellH = (y + h - top - 4) / 2;
  years.forEach((c, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const grupos = porGrupo?.[i];
    const geo = grupos ? MEDIDOR_GRUPOS : MEDIDOR;
    const cx = x + 8 + col * cellW + cellW / 2;
    const cy = top + row * cellH + geo.centro;
    ring(doc, cx, cy, geo.inner, geo.outer, -Math.PI / 2, Math.PI / 2, C.track);
    if (grupos) {
      // L2: el arco de atendidas por grupo (cerradas sin contrato, de
      // contrato y canceladas en Maximo); lo que falta son las abiertas
      let desde = -Math.PI / 2;
      for (const g of grupos.grupos) {
        if (g.clave === 'abiertas' || grupos.recibidas === 0) continue;
        const sweep = Math.PI * (g.valor / grupos.recibidas);
        ring(
          doc,
          cx,
          cy,
          geo.inner,
          geo.outer,
          desde,
          desde + sweep,
          GRUPO_COLOR[g.clave],
        );
        desde += sweep;
      }
    } else {
      const pct = c.atendidas_pct ?? 0;
      ring(
        doc,
        cx,
        cy,
        geo.inner,
        geo.outer,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * Math.min(1, pct / 100),
        GAUGE_COLORS[i] ?? C.verde,
      );
    }
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
    // L2: con grupos, un renglón por grupo, con su nombre completo
    const detalle =
      c.recibidas === 0
        ? 'Sin gestiones'
        : grupos
          ? gruposEnRenglones(grupos)
          : `${fmtInt(c.cerradas)} cerradas · ${fmtInt(c.canceladas)} canceladas\n${fmtInt(c.abiertas)} abiertas`;
    text(doc, detalle, cx - cellW / 2 + 2, cy + geo.detalle, {
      size: 6.3,
      color: C.grisTexto,
      width: cellW - 4,
      align: 'center',
      height: geo.alto,
      ...(grupos ? { lineGap: MEDIDOR_GRUPOS.lineGap } : {}),
    });
  });
}

/** Letra y tope del pie de la tarjeta de montos (H18: hasta 4 renglones). */
const PIE_SIZE = 6.5;
const PIE_MAX_ALTO = 40;

/**
 * H18: alto del pie de montos medido con su letra; +1 de holgura para que
 * el `ellipsis` de `text` no corte el último renglón por redondeo.
 */
export function altoPie(doc: Doc, texto: string, ancho: number): number {
  doc.font(F.r).fontSize(PIE_SIZE);
  const alto = doc.heightOfString(texto, { width: ancho, lineGap: 0 });
  return Math.min(Math.ceil(alto) + 1, PIE_MAX_ALTO);
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
  const deSapMigradas =
    page.fuente.clave === 'maximo' && m.fuente_maximo === 'sap_migradas';
  const top = card(
    doc,
    x,
    y,
    w,
    h,
    `Montos adjudicados ${m.anio}`,
    `${deSapMigradas ? 'OC de SAP creadas desde Maximo' : 'OC'} no canceladas, ${montoBaseTexto(m.base)}, por mes de la OC`,
  );
  // K5: el otro valor (por moneda) y las OC sin subtotal, en una línea chica
  const otroTexto = m.monedas
    .filter((c) => m.otro.total[c] !== undefined)
    .map((c) => `${c} ${fmtMoney(m.otro.total[c])}`)
    .join(' · ');
  const pie = [
    otroTexto
      ? `${m.otro.base === 'con_iva' ? 'Con IVA' : 'Sin IVA'}: ${otroTexto}`
      : null,
    m.sin_subtotal.ordenes > 0
      ? `${fmtInt(m.sin_subtotal.ordenes)} OC sin subtotal (no se estiman)`
      : null,
  ].filter(Boolean);
  if (m.ordenes === 0) {
    text(
      doc,
      m.sin_subtotal.ordenes > 0
        ? `Ninguna OC del año trae el monto ${montoBaseTexto(m.base)}.`
        : 'Sin OC en el año.',
      x + 14,
      top + 6,
      { size: 8, color: C.grisTexto, width: w - 28 },
    );
    if (pie.length > 0) {
      const texto = pie.join('  ·  ');
      text(doc, texto, x + 14, top + 22, {
        size: PIE_SIZE,
        color: C.grisTexto,
        width: w - 28,
        height: altoPie(doc, texto, w - 28),
      });
    }
    return;
  }
  const tableCur = m.monedas.filter((c) => c === 'MXN' || c === 'USD');
  const shown = tableCur.length > 0 ? tableCur : m.monedas.slice(0, 1);
  const extra = m.monedas.filter(
    (c) => !shown.includes(c) && m.total[c] !== undefined,
  );
  if (extra.length > 0) {
    pie.unshift(
      `Además: ${extra.map((c) => `${c} ${fmtMoney(m.total[c] ?? 0)}`).join(' · ')} (sin convertir)`,
    );
  }
  const tx = x + 10;
  const tw = w - 20;
  const mesW = 58;
  const curW = (tw - mesW) / shown.length;
  const rows = m.meses.length + 2;
  // H18: el pie ocupa los renglones que necesite (hasta PIE_MAX_ALTO) y la
  // tabla le cede ese alto; antes cabía un renglón y se cortaba con "…"
  const pieTexto = pie.join('  ·  ');
  const pieAlto = pie.length > 0 ? altoPie(doc, pieTexto, tw) : 0;
  const avail = y + h - top - (pie.length > 0 ? pieAlto + 7 : 8);
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
      // H9: mes con OC sin subtotal (base sin IVA) ≠ mes sin compras ("—")
      const sinBase =
        v === undefined &&
        m.base === 'sin_iva' &&
        (mes.sin_subtotal[cur] ?? 0) > 0;
      text(
        doc,
        v !== undefined ? fmtMoney(v) : sinBase ? 'No disponible' : '—',
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
    const t = m.total[cur];
    text(
      doc,
      t === undefined ? '—' : fmtMoney(t),
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
  if (pie.length > 0) {
    text(doc, pieTexto, tx, ry, {
      size: PIE_SIZE,
      color: C.grisTexto,
      width: tw,
      height: pieAlto,
    });
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
  const porGrupo = page.grupos?.anual;
  // L2: con grupos, la barra de atendidas va apilada (cerradas sin contrato,
  // de contrato y canceladas en Maximo, de abajo hacia arriba) y la leyenda
  // los nombra
  const legend = page.grupos
    ? [
        { label: 'Recibidas', color: C.verdeOscuro },
        ...page.grupos.estado_anio.grupos
          .filter((g) => g.clave !== 'abiertas')
          .map((g) => ({ label: g.etiqueta, color: GRUPO_COLOR[g.clave] })),
      ]
    : [
        { label: 'Recibidas', color: C.verdeOscuro },
        { label: 'Atendidas', color: C.verdeClaro },
      ];
  let lx = x + 20;
  let renglonesLeyenda = 1;
  for (const l of legend) {
    if (porGrupo) {
      // L2: la leyenda fluye y baja de renglón si no cabe en la tarjeta
      doc.font(F.r).fontSize(7.2);
      const ancho = 10 + doc.widthOfString(l.label);
      if (lx > x + 20 && lx + ancho > x + w - 14) {
        lx = x + 20;
        renglonesLeyenda += 1;
      }
      const ly = top + (renglonesLeyenda - 1) * 11;
      doc.roundedRect(lx, ly + 1, 7, 7, 1.5).fill(l.color);
      text(doc, l.label, lx + 10, ly - 1, { size: 7.2, color: C.grisTexto });
      lx += ancho + 12;
      continue;
    }
    doc.roundedRect(lx, top + 1, 7, 7, 1.5).fill(l.color);
    text(doc, l.label, lx + 10, top - 1, { size: 7.2, color: C.grisTexto });
    lx += 62;
  }
  const chartX = x + 14;
  const chartW = w - 28;
  const chartTop = top + 22 + (renglonesLeyenda - 1) * 11;
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
    const bars: Array<{
      v: number;
      color: string;
      bx: number;
      grupos?: GruposConteo;
    }> = [
      { v: c.recibidas, color: C.verdeOscuro, bx: gx - barW - 1.5 },
      {
        v: c.atendidas,
        color: C.verdeClaro,
        bx: gx + 1.5,
        grupos: porGrupo?.[i],
      },
    ];
    for (const b of bars) {
      const bh = (b.v / max) * (chartH - 12);
      if (bh > 0 && b.grupos) {
        // L2: los tramos suman las atendidas (mismo alto que la barra sola)
        let base = chartBottom;
        for (const g of b.grupos.grupos) {
          if (g.clave === 'abiertas') continue;
          const gh = (g.valor / max) * (chartH - 12);
          if (gh > 0) {
            doc.rect(b.bx, base - gh, barW, gh).fill(GRUPO_COLOR[g.clave]);
          }
          base -= gh;
        }
      } else if (bh > 0) {
        doc.rect(b.bx, chartBottom - bh, barW, bh).fill(b.color);
      }
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
    subtitle: page.cierre.nota,
    anio: page.cierre.anio,
    anioLabel: String(page.semana.anio),
    eventLabel: 'Cerradas',
    nLabel: `cerradas con OC de ${page.semana.anio}`,
    unidad: page.cierre.unidad,
    semanas: page.cierre.semanas.map((s) => ({
      lunes: s.lunes,
      n: s.cerradas,
      dias: s.dias,
    })),
  });
  diasCard(doc, xs[2], upperY, widths[2], upperH, {
    title: 'Tiempo de cancelación',
    subtitle: page.cancelacion.nota,
    anio: page.cancelacion.anio,
    anioLabel: String(page.semana.anio),
    eventLabel: 'Canceladas',
    nLabel: `canceladas de ${page.semana.anio}`,
    unidad: page.cancelacion.unidad,
    semanas: page.cancelacion.semanas.map((s) => ({
      lunes: s.lunes,
      n: s.canceladas,
      dias: s.dias,
    })),
  });
  donaCard(doc, page, xs[3], upperY, widths[3], upperH);

  banda(doc, 326, page.grupos ? BANDA.grupos : BANDA.estandar);

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
    const semanas = new Set(pages.map((p) => p.semana.lunes)).size;
    const fuentes = [...new Set(pages.map((p) => p.fuente.etiqueta))];
    const doc = new PDFDocument({
      autoFirstPage: false,
      size: 'LETTER',
      layout: 'landscape',
      margin: 0,
      info: {
        Title:
          semanas === 1 && first
            ? `Reporte de avance semanal (${fuentes.join(' y ')}) — ${first.semana.etiqueta}`
            : `Reporte de avance semanal (${fuentes.join(' y ')}) — acumulado`,
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
    // I3: marcadores = índice por sistema y semana
    let seccion: { clave: string; item: PDFKit.PDFOutline } | null = null;
    pages.forEach((page, i) => {
      doc.addPage({ size: 'LETTER', layout: 'landscape', margin: 0 });
      if (seccion?.clave !== page.fuente.clave) {
        seccion = {
          clave: page.fuente.clave,
          item: doc.outline.addItem(page.fuente.etiqueta, { expanded: true }),
        };
      }
      seccion.item.addItem(page.semana.etiqueta);
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

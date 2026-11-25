/**
 * Almacén — el paquete de un corte y su validación, antes de cargarlo
 * (scripts/almacen-cargar.ts). El paquete lo arma, a partir del Excel que
 * aceptó Contabilidad, documentation/inventario_henry/exportar.js. Funciones
 * puras: las prueba almacen-carga.spec.ts.
 *
 * Formato 1: la versión 1 del reporte (solo CENTRAL). Formato 2 (0027): todas
 * las ubicaciones, lo que va sin costo con su motivo, las devoluciones sin OT
 * y su serie por mes, la versión del reporte y la lista de ubicaciones.
 */
import { createHash } from 'crypto';

export const FORMATO_V1 = 'almacen-corte/1';
export const FORMATO_V2 = 'almacen-corte/2';
export const FORMATOS = [FORMATO_V1, FORMATO_V2];

export const ORIGENES = [
  'Recepción',
  'Devolución al almacén',
  'Recepción de salida directa',
  'Recepción a otro almacén',
  'Sin entrada con costo',
] as const;

export const SIN_ENTRADA = 'Sin entrada con costo';
/** Por qué algo va sin costo (formato 2); puede ir más de uno, con " y ". */
export const MOTIVOS = [
  'Sin compras en Maximo',
  'Solo compras de salida directa',
  'Sus compras no alcanzan',
  'Devolución en 0',
];
/** Lo que llama la atención de una devolución sin OT (formato 2). */
export const MARCAS = [
  'Nunca había salido del almacén',
  'Regresó más de lo que había salido',
  'Costo 0 en Maximo',
  'También tiene saldo en otra ubicación',
];
export const GRUPOS = [
  'CENTRAL',
  'Almacenes y contenedores',
  'Cajas de herramientas',
  'Zona de recepción',
];

export interface FilaPaquete {
  orden: number;
  parte: string;
  descripcion: string;
  /** El almacén de la fila (en el formato 2, cualquiera de las ubicaciones). */
  almacen: string;
  almacenFisico: string | null;
  clasificacion: string | null;
  costo: number | null;
  moneda: string | null;
  cantidad: number;
  unidad: string | null;
  /** Hora de México, sin zona: 'AAAA-MM-DDTHH:MM:SS'. */
  fechaEntrada: string | null;
  fechaCaptura: string | null;
  tipoCambio: number | null;
  importePesos: number | null;
  tipoCambioOc: number | null;
  importePesosOc: number | null;
  origen: string;
  oc: string | null;
  fuenteTc: string | null;
  fuenteTcOc: string | null;
  /** El saldo al corte del artículo en el almacén de la fila. */
  saldoArticulo: number;
  regresaronRecientes: number | null;
  herramienta: boolean;
  /** Si está en su INVENTARIO AL CORTE (solo CENTRAL; null fuera de CENTRAL, en el formato 2). */
  enSuInventario: boolean | null;
  unidadEntrada: string | null;
  nota: string | null;
  /** Formato 2: solo en lo que va sin costo. */
  motivo?: string | null;
  comoLlego?: string | null;
}

export interface Ubicacion {
  clave: string;
  descripcion: string;
  tipo: string;
  grupo: string;
}

export interface DevolucionPaquete {
  orden: number;
  fecha: string;
  fechaCaptura: string | null;
  documento: string | null;
  documentoDescripcion: string | null;
  almacen: string;
  anaquel: string | null;
  parte: string;
  descripcion: string;
  cantidad: number;
  unidad: string | null;
  costoMaximoUsd: number;
  costo: number | null;
  moneda: string | null;
  tipoCambio: number | null;
  importePesos: number | null;
  tipoCambioOc: number | null;
  importePesosOc: number | null;
  valuacion: string | null;
  oc: string | null;
  observacion: string | null;
  marcas: string[];
  salioAntes: number | null;
  salio12m: number | null;
  ultimaSalida: string | null;
  otUltimaSalida: string | null;
  saldoAlmacen: number | null;
  saldoOtras: number | null;
}

export interface DevolucionesMes {
  /** 'AAAA-MM' */
  mes: string;
  lineas: number;
  unidades: number;
}

export interface PaqueteCorte {
  formato: string;
  /** El alcance: CENTRAL (formato 1) o TODOS (formato 2). */
  almacen: string;
  /** Hora de México, sin zona: 'AAAA-MM-DDTHH:MM:SS'. */
  fechaCorte: string;
  titulo: string;
  fuente: string;
  totales: {
    pesos: number;
    pesosOc: number;
    /** Artículos distintos. */
    articulos: number;
    unidades: number;
    /** Artículos distintos con algo sin costo. */
    sinValuarArticulos: number;
    sinValuarUnidades: number;
  };
  notas: [string, string][];
  archivo: { nombre: string; sha256: string; base64: string };
  existencias: FilaPaquete[];
  /** Formato 2. */
  versionReporte?: number;
  ubicaciones?: Ubicacion[];
  devoluciones?: DevolucionPaquete[];
  devolucionesPorMes?: DevolucionesMes[];
}

const FECHA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
/**
 * El nombre va tal cual en la cabecera de la descarga: ASCII imprimible, sin
 * comillas ni diagonal invertida (como el CHECK ck_almacen_cortes_archivo).
 */
const NOMBRE_EXCEL = /^[ -~]+\.xlsx$/;
const cerca = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const r4 = (x: number) => Math.round(x * 10000) / 10000;
/** costo × cantidad × tipo de cambio, con la tolerancia de redondeo de seis decimales. */
const cuadra = (importe: number, costo: number, cantidad: number, tc: number) =>
  cerca(
    importe,
    costo * cantidad * tc,
    1e-6 * Math.max(1, Math.abs(costo * cantidad * tc)),
  );

/** El Excel del paquete, decodificado. */
export function archivoDe(p: PaqueteCorte): Buffer {
  return Buffer.from(p.archivo.base64, 'base64');
}

/** Los campos de una fila en un orden fijo: la huella no depende del orden de las claves del JSON. */
const CAMPOS_FILA: (keyof FilaPaquete)[] = [
  'orden',
  'parte',
  'descripcion',
  'almacen',
  'almacenFisico',
  'clasificacion',
  'costo',
  'moneda',
  'cantidad',
  'unidad',
  'fechaEntrada',
  'fechaCaptura',
  'tipoCambio',
  'importePesos',
  'tipoCambioOc',
  'importePesosOc',
  'origen',
  'oc',
  'fuenteTc',
  'fuenteTcOc',
  'saldoArticulo',
  'regresaronRecientes',
  'herramienta',
  'enSuInventario',
  'unidadEntrada',
  'nota',
];
const CAMPOS_FILA_V2: (keyof FilaPaquete)[] = [
  ...CAMPOS_FILA,
  'motivo',
  'comoLlego',
];
const CAMPOS_DEVOLUCION: (keyof DevolucionPaquete)[] = [
  'orden',
  'fecha',
  'fechaCaptura',
  'documento',
  'documentoDescripcion',
  'almacen',
  'anaquel',
  'parte',
  'descripcion',
  'cantidad',
  'unidad',
  'costoMaximoUsd',
  'costo',
  'moneda',
  'tipoCambio',
  'importePesos',
  'tipoCambioOc',
  'importePesosOc',
  'valuacion',
  'oc',
  'observacion',
  'marcas',
  'salioAntes',
  'salio12m',
  'ultimaSalida',
  'otUltimaSalida',
  'saldoAlmacen',
  'saldoOtras',
];

/**
 * La huella del paquete: sha256 de todo lo que se guarda (almacén, fecha,
 * título, fuente, totales, notas, el Excel por su sha256 y cada fila) en un
 * orden fijo. Es la llave de la carga: el mismo Excel con otra clasificación
 * (que sale de otro archivo) da otra huella. En el formato 1 es la misma de
 * siempre; el 2 suma lo suyo.
 */
export function huellaPaquete(p: PaqueteCorte): string {
  const t = p.totales;
  const v2 = p.formato === FORMATO_V2;
  const contenido: unknown[] = [
    p.formato,
    p.almacen,
    p.fechaCorte,
    p.titulo,
    p.fuente,
    [
      t.pesos,
      t.pesosOc,
      t.articulos,
      t.unidades,
      t.sinValuarArticulos,
      t.sinValuarUnidades,
    ],
    p.notas,
    [p.archivo.nombre, p.archivo.sha256],
    p.existencias.map((f) =>
      (v2 ? CAMPOS_FILA_V2 : CAMPOS_FILA).map((k) => f[k] ?? null),
    ),
  ];
  if (v2)
    contenido.push(
      p.versionReporte ?? null,
      (p.ubicaciones ?? []).map((u) => [
        u.clave,
        u.descripcion,
        u.tipo,
        u.grupo,
      ]),
      (p.devoluciones ?? []).map((d) =>
        CAMPOS_DEVOLUCION.map((k) => d[k] ?? null),
      ),
      (p.devolucionesPorMes ?? []).map((m) => [m.mes, m.lineas, m.unidades]),
    );
  return createHash('sha256').update(JSON.stringify(contenido)).digest('hex');
}

/** Las ubicaciones y las devoluciones del formato 2. */
function validarV2(p: PaqueteCorte, problemas: string[]) {
  if (p.almacen !== 'TODOS')
    problemas.push(
      `el formato 2 es de todos los almacenes: almacén "TODOS", no "${p.almacen}"`,
    );
  if (!Number.isInteger(p.versionReporte) || (p.versionReporte ?? 0) < 1)
    problemas.push('la versión del reporte no es un entero de 1 en adelante');
  const ubicaciones = Array.isArray(p.ubicaciones) ? p.ubicaciones : [];
  if (!ubicaciones.length) problemas.push('no trae la lista de ubicaciones');
  const claves = new Set<string>();
  for (const u of ubicaciones) {
    if (!u?.clave?.trim() || u.clave !== u.clave.trim())
      problemas.push('una ubicación no tiene clave o trae espacios');
    else if (claves.has(u.clave))
      problemas.push(`la ubicación ${u.clave} se repite`);
    claves.add(u?.clave);
    if (!GRUPOS.includes(u?.grupo))
      problemas.push(
        `la ubicación ${u?.clave}: grupo "${u?.grupo}" desconocido`,
      );
    if (typeof u?.descripcion !== 'string' || typeof u?.tipo !== 'string')
      problemas.push(`la ubicación ${u?.clave}: sin descripción o tipo`);
  }
  for (const f of p.existencias ?? []) {
    const donde = `fila ${f.orden} (${f.parte}, ${f.almacen})`;
    if (!claves.has(f.almacen))
      problemas.push(`${donde}: su almacén no está en las ubicaciones`);
    if (f.origen === SIN_ENTRADA) {
      if (!f.motivo || !f.motivo.split(' y ').every((m) => MOTIVOS.includes(m)))
        problemas.push(
          `${donde}: lo que va sin costo necesita un motivo conocido`,
        );
    } else if (f.motivo) problemas.push(`${donde}: tiene costo y trae motivo`);
    if (
      f.almacen === 'CENTRAL'
        ? typeof f.enSuInventario !== 'boolean'
        : f.enSuInventario !== null
    )
      problemas.push(`${donde}: "en su inventario" solo aplica en CENTRAL`);
  }
  const devoluciones = Array.isArray(p.devoluciones) ? p.devoluciones : [];
  const vistos = new Set<number>();
  for (const d of devoluciones) {
    const donde = `devolución ${d.orden} (${d.parte})`;
    if (!Number.isInteger(d.orden) || d.orden < 1 || vistos.has(d.orden))
      problemas.push(`${donde}: orden inválido o repetido`);
    vistos.add(d.orden);
    if (!FECHA.test(d.fecha ?? '') || d.fecha > p.fechaCorte)
      problemas.push(`${donde}: fecha inválida o después del corte`);
    if (!d.parte?.trim() || !claves.has(d.almacen))
      problemas.push(
        `${donde}: sin parte o con un almacén que no está en las ubicaciones`,
      );
    if (!(d.cantidad > 0)) problemas.push(`${donde}: cantidad ${d.cantidad}`);
    if (!(d.costoMaximoUsd >= 0))
      problemas.push(`${donde}: costo de Maximo inválido`);
    if (!Array.isArray(d.marcas) || d.marcas.some((m) => !MARCAS.includes(m)))
      problemas.push(
        `${donde}: las marcas no son una lista de marcas conocidas`,
      );
    if (d.fechaCaptura !== null && !FECHA.test(d.fechaCaptura ?? ''))
      problemas.push(`${donde}: fecha de captura inválida`);
    if (
      d.ultimaSalida !== null &&
      (!FECHA.test(d.ultimaSalida ?? '') || d.ultimaSalida > d.fecha)
    )
      problemas.push(
        `${donde}: la última salida es inválida o no es anterior a la devolución`,
      );
    const valuada = [
      d.costo,
      d.moneda,
      d.tipoCambio,
      d.importePesos,
      d.tipoCambioOc,
      d.importePesosOc,
    ];
    if (valuada.every((x) => x === null)) continue;
    if (
      !(d.costo! > 0) ||
      !/^[A-Z]{3}$/.test(d.moneda ?? '') ||
      !(d.tipoCambio! > 0) ||
      !(d.tipoCambioOc! > 0) ||
      d.importePesos === null ||
      d.importePesosOc === null
    ) {
      problemas.push(`${donde}: valuada a medias`);
      continue;
    }
    if (d.moneda === 'MXN' && (d.tipoCambio !== 1 || d.tipoCambioOc !== 1))
      problemas.push(`${donde}: en pesos el tipo de cambio debe ser 1`);
    if (
      !cuadra(d.importePesos, d.costo!, d.cantidad, d.tipoCambio!) ||
      !cuadra(d.importePesosOc, d.costo!, d.cantidad, d.tipoCambioOc!)
    )
      problemas.push(`${donde}: importe ≠ costo × cantidad × tipo de cambio`);
  }
  const meses = Array.isArray(p.devolucionesPorMes) ? p.devolucionesPorMes : [];
  if (
    meses.some(
      (m, i) =>
        !/^\d{4}-\d{2}$/.test(m?.mes ?? '') ||
        m.mes > p.fechaCorte.slice(0, 7) ||
        (i > 0 && m.mes <= meses[i - 1].mes) ||
        !Number.isInteger(m.lineas) ||
        m.lineas < 0 ||
        !(m.unidades >= 0),
    )
  )
    problemas.push('la serie por mes de las devoluciones no es válida');
  // Los meses del detalle tienen en la serie las mismas líneas que el detalle.
  const porMes = new Map<string, number>();
  for (const d of devoluciones) {
    const k = (d.fecha ?? '').slice(0, 7);
    porMes.set(k, (porMes.get(k) ?? 0) + 1);
  }
  for (const [mes, lineas] of porMes) {
    const s = meses.find((m) => m?.mes === mes);
    if (!s || s.lineas !== lineas)
      problemas.push(
        `la serie por mes dice ${s?.lineas ?? 0} devoluciones en ${mes} y el detalle trae ${lineas}`,
      );
  }
  // Toda ubicación de la lista tiene existencias o devoluciones.
  const usadas = new Set([
    ...(p.existencias ?? []).map((f) => f.almacen),
    ...devoluciones.map((d) => d.almacen),
  ]);
  for (const c of claves)
    if (!usadas.has(c))
      problemas.push(`la ubicación ${c} no tiene existencias ni devoluciones`);
}

/**
 * Revisa que el paquete sea coherente: formato, Excel (que sus bytes den su
 * sha256 y su nombre), filas (orden, origen, cantidades, valuación y su
 * aritmética), que cada artículo sume su saldo en cada almacén y que los
 * totales sean la suma de las filas; en el formato 2, también las ubicaciones,
 * los motivos y las devoluciones. Que el Excel sea el aceptado lo revisa la
 * carga contra --excel-sha256. Regresa la lista de problemas (vacía = se carga).
 */
export function validarPaquete(p: PaqueteCorte): string[] {
  const problemas: string[] = [];
  if (!FORMATOS.includes(p.formato))
    problemas.push(
      `formato "${p.formato}", se espera "${FORMATOS.join('" o "')}"`,
    );
  if (!p.almacen || p.almacen.trim() !== p.almacen)
    problemas.push('falta el almacén o trae espacios');
  if (!FECHA.test(p.fechaCorte ?? ''))
    problemas.push(
      `fecha de corte "${p.fechaCorte}" no es AAAA-MM-DDTHH:MM:SS`,
    );
  if (!p.titulo?.trim()) problemas.push('falta el título');
  if (!p.fuente?.trim()) problemas.push('falta la fuente');
  if (
    !Array.isArray(p.notas) ||
    p.notas.some((n) => !Array.isArray(n) || n.length !== 2)
  )
    problemas.push('las notas no son una lista de [título, texto]');
  if (!/^[0-9a-f]{64}$/.test(p.archivo?.sha256 ?? ''))
    problemas.push('el sha256 del Excel no es válido');
  else {
    const b = archivoDe(p);
    const sha = createHash('sha256').update(b).digest('hex');
    if (b.length === 0) problemas.push('el Excel viene vacío');
    else if (sha !== p.archivo.sha256)
      problemas.push(
        `el Excel del paquete está dañado: su sha256 es ${sha.slice(0, 12)}… y el paquete dice ${p.archivo.sha256.slice(0, 12)}…`,
      );
  }
  const nombre = p.archivo?.nombre ?? '';
  if (!NOMBRE_EXCEL.test(nombre) || /["\\]/.test(nombre) || nombre.length > 160)
    problemas.push(
      `el nombre del Excel ("${nombre}") debe terminar en .xlsx, tener hasta 160 caracteres y ser ASCII, sin acentos, comillas ni diagonal invertida`,
    );

  const filas = p.existencias ?? [];
  if (filas.length === 0) problemas.push('no trae existencias');
  const vistos = new Set<number>();
  // El saldo se cuadra por artículo y almacén (en el formato 1, todo es de un almacén).
  const porPar = new Map<
    string,
    { parte: string; suma: number; saldo: number }
  >();
  for (const f of filas) {
    const donde = `fila ${f.orden} (${f.parte})`;
    if (!Number.isInteger(f.orden) || f.orden < 1)
      problemas.push(`${donde}: orden inválido`);
    if (vistos.has(f.orden)) problemas.push(`${donde}: orden repetido`);
    vistos.add(f.orden);
    if (!f.parte?.trim()) problemas.push(`${donde}: sin parte`);
    if (!f.almacen?.trim()) problemas.push(`${donde}: sin almacén`);
    if (!(ORIGENES as readonly string[]).includes(f.origen))
      problemas.push(`${donde}: origen "${f.origen}" desconocido`);
    if (!(f.cantidad > 0)) problemas.push(`${donde}: cantidad ${f.cantidad}`);
    if (f.fechaEntrada !== null && !FECHA.test(f.fechaEntrada))
      problemas.push(`${donde}: fecha de entrada inválida`);
    if (f.fechaCaptura !== null && !FECHA.test(f.fechaCaptura))
      problemas.push(`${donde}: fecha de captura inválida`);
    if (f.fechaEntrada && f.fechaEntrada > p.fechaCorte)
      problemas.push(`${donde}: entrada después del corte`);
    if (f.origen === SIN_ENTRADA) {
      if (
        [
          f.costo,
          f.moneda,
          f.fechaEntrada,
          f.tipoCambio,
          f.importePesos,
          f.tipoCambioOc,
          f.importePesosOc,
        ].some((x) => x !== null)
      )
        problemas.push(
          `${donde}: "Sin entrada con costo" trae costo o importes`,
        );
    } else {
      if (
        !(f.costo! > 0) ||
        !f.moneda ||
        !f.fechaEntrada ||
        !(f.tipoCambio! > 0) ||
        !(f.tipoCambioOc! > 0) ||
        f.importePesos === null ||
        f.importePesosOc === null
      ) {
        problemas.push(
          `${donde}: fila valuada sin costo, moneda, fecha, tipo de cambio o importe`,
        );
      } else {
        if (!/^[A-Z]{3}$/.test(f.moneda))
          problemas.push(`${donde}: moneda "${f.moneda}"`);
        if (f.moneda === 'MXN' && (f.tipoCambio !== 1 || f.tipoCambioOc !== 1))
          problemas.push(`${donde}: en pesos el tipo de cambio debe ser 1`);
        if (!cuadra(f.importePesos, f.costo!, f.cantidad, f.tipoCambio!))
          problemas.push(
            `${donde}: importe en pesos ≠ costo × cantidad × tipo de cambio`,
          );
        if (!cuadra(f.importePesosOc, f.costo!, f.cantidad, f.tipoCambioOc!))
          problemas.push(
            `${donde}: importe con el tipo de cambio de la OC no cuadra`,
          );
      }
    }
    const k = `${f.almacen}|${f.parte}`;
    const x = porPar.get(k) ?? {
      parte: f.parte,
      suma: 0,
      saldo: f.saldoArticulo,
    };
    if (x.saldo !== f.saldoArticulo)
      problemas.push(`${donde}: el saldo del artículo cambia entre sus filas`);
    x.suma += f.cantidad;
    porPar.set(k, x);
  }
  for (const [k, x] of porPar)
    if (!cerca(r4(x.suma), x.saldo, 1e-6))
      problemas.push(
        `${p.formato === FORMATO_V1 ? x.parte : k.replace('|', ', ')}: sus filas suman ${r4(x.suma)} y su saldo es ${x.saldo}`,
      );

  const t = p.totales;
  const suma = (fn: (f: FilaPaquete) => number) =>
    filas.reduce((s, f) => s + fn(f), 0);
  const sinValuar = filas.filter((f) => f.origen === SIN_ENTRADA);
  if (
    !cerca(
      suma((f) => f.importePesos ?? 0),
      t.pesos,
      0.01,
    )
  )
    problemas.push(
      `el total en pesos (${t.pesos}) no es la suma de las filas (${suma((f) => f.importePesos ?? 0).toFixed(2)})`,
    );
  if (
    !cerca(
      suma((f) => f.importePesosOc ?? 0),
      t.pesosOc,
      0.01,
    )
  )
    problemas.push(
      `el total con el tipo de cambio de la OC (${t.pesosOc}) no es la suma de las filas`,
    );
  const articulos = new Set(filas.map((f) => f.parte)).size;
  if (articulos !== t.articulos)
    problemas.push(
      `artículos: ${t.articulos} en los totales y ${articulos} en las filas`,
    );
  if (!cerca(r4(suma((f) => f.cantidad)), t.unidades, 1e-6))
    problemas.push(
      `unidades: ${t.unidades} en los totales y ${r4(suma((f) => f.cantidad))} en las filas`,
    );
  if (new Set(sinValuar.map((f) => f.parte)).size !== t.sinValuarArticulos)
    problemas.push('los artículos sin valuar no cuadran');
  if (
    !cerca(
      r4(sinValuar.reduce((s, f) => s + f.cantidad, 0)),
      t.sinValuarUnidades,
      1e-6,
    )
  )
    problemas.push('las unidades sin valuar no cuadran');
  if (p.formato === FORMATO_V2) validarV2(p, problemas);
  return problemas;
}

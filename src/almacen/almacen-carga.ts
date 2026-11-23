/**
 * Almacén — el paquete de un corte y su validación, antes de cargarlo
 * (scripts/almacen-cargar.ts). El paquete lo arma, a partir del Excel que
 * aceptó Contabilidad, documentation/inventario_henry/exportar.js. Funciones
 * puras: las prueba almacen-carga.spec.ts.
 */
import { createHash } from 'crypto';

export const FORMATO_PAQUETE = 'almacen-corte/1';

export const ORIGENES = [
  'Recepción',
  'Devolución al almacén',
  'Recepción de salida directa',
  'Recepción a otro almacén',
  'Sin entrada con costo',
] as const;

export const SIN_ENTRADA = 'Sin entrada con costo';

export interface FilaPaquete {
  orden: number;
  parte: string;
  descripcion: string;
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
  saldoArticulo: number;
  regresaronRecientes: number | null;
  herramienta: boolean;
  enSuInventario: boolean;
  unidadEntrada: string | null;
  nota: string | null;
}

export interface PaqueteCorte {
  formato: string;
  almacen: string;
  /** Hora de México, sin zona: 'AAAA-MM-DDTHH:MM:SS'. */
  fechaCorte: string;
  titulo: string;
  fuente: string;
  totales: {
    pesos: number;
    pesosOc: number;
    articulos: number;
    unidades: number;
    sinValuarArticulos: number;
    sinValuarUnidades: number;
  };
  notas: [string, string][];
  archivo: { nombre: string; sha256: string; base64: string };
  existencias: FilaPaquete[];
}

const FECHA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
/**
 * El nombre va tal cual en la cabecera de la descarga: ASCII imprimible, sin
 * comillas ni diagonal invertida (como el CHECK ck_almacen_cortes_archivo).
 */
const NOMBRE_EXCEL = /^[ -~]+\.xlsx$/;
const cerca = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

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

/**
 * La huella del paquete: sha256 de todo lo que se guarda (almacén, fecha,
 * título, fuente, totales, notas, el Excel por su sha256 y cada fila) en un
 * orden fijo. Es la llave de la carga: el mismo Excel con otra clasificación
 * (que sale de otro archivo) da otra huella.
 */
export function huellaPaquete(p: PaqueteCorte): string {
  const t = p.totales;
  const contenido = [
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
    p.existencias.map((f) => CAMPOS_FILA.map((k) => f[k] ?? null)),
  ];
  return createHash('sha256').update(JSON.stringify(contenido)).digest('hex');
}

/**
 * Revisa que el paquete sea coherente: formato, Excel (que sus bytes den su
 * sha256 y su nombre), filas (orden, origen, cantidades, valuación y su
 * aritmética) y que los totales sean la suma de las filas. Que el Excel sea
 * el aceptado lo revisa la carga contra --excel-sha256. Regresa la lista de
 * problemas (vacía = se carga).
 */
export function validarPaquete(p: PaqueteCorte): string[] {
  const problemas: string[] = [];
  if (p.formato !== FORMATO_PAQUETE)
    problemas.push(`formato "${p.formato}", se espera "${FORMATO_PAQUETE}"`);
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
  const porParte = new Map<string, { suma: number; saldo: number }>();
  for (const f of filas) {
    const donde = `fila ${f.orden} (${f.parte})`;
    if (!Number.isInteger(f.orden) || f.orden < 1)
      problemas.push(`${donde}: orden inválido`);
    if (vistos.has(f.orden)) problemas.push(`${donde}: orden repetido`);
    vistos.add(f.orden);
    if (!f.parte?.trim()) problemas.push(`${donde}: sin parte`);
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
        const esperado = f.costo! * f.cantidad;
        if (
          !cerca(
            f.importePesos,
            esperado * f.tipoCambio!,
            1e-6 * Math.max(1, Math.abs(esperado * f.tipoCambio!)),
          )
        )
          problemas.push(
            `${donde}: importe en pesos ≠ costo × cantidad × tipo de cambio`,
          );
        if (
          !cerca(
            f.importePesosOc,
            esperado * f.tipoCambioOc!,
            1e-6 * Math.max(1, Math.abs(esperado * f.tipoCambioOc!)),
          )
        )
          problemas.push(
            `${donde}: importe con el tipo de cambio de la OC no cuadra`,
          );
      }
    }
    const x = porParte.get(f.parte) ?? { suma: 0, saldo: f.saldoArticulo };
    if (x.saldo !== f.saldoArticulo)
      problemas.push(`${donde}: el saldo del artículo cambia entre sus filas`);
    x.suma += f.cantidad;
    porParte.set(f.parte, x);
  }
  for (const [parte, x] of porParte)
    if (!cerca(r4(x.suma), x.saldo, 1e-6))
      problemas.push(
        `${parte}: sus filas suman ${r4(x.suma)} y su saldo es ${x.saldo}`,
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
  if (porParte.size !== t.articulos)
    problemas.push(
      `artículos: ${t.articulos} en los totales y ${porParte.size} en las filas`,
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
  return problemas;
}

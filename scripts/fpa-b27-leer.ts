/**
 * FP&A (bloque C, C3) — lee los Excel del presupuesto 2027 de Laura (plantilla
 * de David, F2/B27) y escribe lo que carga `fpa:b27`
 * (scripts/data/fpa-b27.json), con el reporte de lo que no cuadra.
 *
 * Se corre en la computadora donde están los archivos; el JSON se revisa y se
 * sube al repo, así que en prod no hacen falta los Excel. La lógica vive en
 * src/fpa/carga/plantilla.ts, con pruebas; el catálogo, en
 * scripts/data/fpa-coa.json (fpa:coa-leer).
 *
 * USO:
 *   npm run fpa:b27-leer -- "<carpeta o archivos .xlsx>" [--salida <ruta.json>]
 *   (sin rutas, lee documentation/fpa/drive/B-27/: ahí deja Alex los de Laura;
 *   un archivo sin el bloque 2027 se omite con aviso)
 *
 * Sale con código 1 si hay problemas (un monto sin valor guardado, una fila
 * con 2027 fuera de toda área, parámetros distintos entre archivos…).
 */
import { createHash } from 'crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join, resolve } from 'path';
import * as XLSX from 'xlsx';
import type { CatalogoCoa } from '../src/fpa/carga/coa';
import { clave } from '../src/fpa/carga/normalizar';
import {
  dolarDeLasFormulas,
  leerHoja,
  lineasDeHoja,
  POR_CLASIFICAR,
  type ArchivoB27,
  type ContextoCatalogo,
  type HojaLeida,
  type HojaPlantilla,
} from '../src/fpa/carga/plantilla';

const POR_OMISION = resolve(__dirname, '../../documentation/fpa/drive/B-27');
const SALIDA_POR_OMISION = join(__dirname, 'data', 'fpa-b27.json');
const HOJAS_CONOCIDAS = ['2026-2027', 'Detailed'];

function opcion(nombre: string): string | null {
  const i = process.argv.indexOf(nombre);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function archivosDe(rutas: string[]): string[] {
  const salida: string[] = [];
  for (const r of rutas) {
    if (statSync(r).isDirectory()) {
      for (const n of readdirSync(r).sort()) {
        if (/\.xlsx$/i.test(n) && !n.startsWith('~$')) salida.push(join(r, n));
      }
    } else salida.push(r);
  }
  return salida;
}

/** La hoja de SheetJS vista como la hoja abstracta de plantilla.ts. */
function adaptar(nombre: string, ws: XLSX.WorkSheet): HojaPlantilla {
  const rango = XLSX.utils.decode_range(ws['!ref'] ?? 'A1:A1');
  return {
    nombre,
    maxFila: rango.e.r + 1,
    maxCol: Math.min(rango.e.c + 1, 60),
    celda(fila, col) {
      const c = ws[XLSX.utils.encode_cell({ r: fila - 1, c: col - 1 })] as
        | XLSX.CellObject
        | undefined;
      if (!c || c.t === 'z') return undefined;
      // Un error de Excel (#REF!, #VALUE!) cuenta como texto
      const v =
        c.t === 'e'
          ? (c.w ?? '#ERROR')
          : (c.v as number | string | boolean | undefined);
      return { v: v ?? null, f: c.f ?? null };
    },
    oculta(fila) {
      return ws['!rows']?.[fila - 1]?.hidden === true;
    },
  };
}

/** La hoja principal: la de nombre conocido o la única visible con 2027. */
function hojaPrincipal(
  libro: XLSX.WorkBook,
  archivo: string,
): { leida: HojaLeida | null; motivo: string } {
  const visibles = libro.SheetNames.filter(
    (n, i) => !(libro.Workbook?.Sheets?.[i]?.Hidden ?? 0),
  );
  const forzada = opcion('--hoja');
  const candidatas = forzada
    ? [forzada]
    : (() => {
        const conocida = visibles.find((n) => HOJAS_CONOCIDAS.includes(n));
        return conocida ? [conocida] : visibles;
      })();
  const leidas: HojaLeida[] = [];
  const errores: string[] = [];
  for (const n of candidatas) {
    const ws = libro.Sheets[n];
    if (!ws) continue;
    try {
      leidas.push(leerHoja(adaptar(n, ws)));
    } catch (e) {
      errores.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (leidas.length === 1) return { leida: leidas[0], motivo: '' };
  if (leidas.length === 0) {
    return { leida: null, motivo: errores.join(' · ') };
  }
  throw new Error(
    `${archivo}: varias hojas tienen el bloque 2027 (${leidas.map((l) => l.hoja).join(', ')}); elige una con --hoja`,
  );
}

function main() {
  const rutas = process.argv
    .slice(2)
    .filter(
      (a, i, all) =>
        !a.startsWith('--') &&
        all[i - 1] !== '--salida' &&
        all[i - 1] !== '--hoja',
    );
  const archivos = archivosDe(rutas.length ? rutas : [POR_OMISION]);
  if (archivos.length === 0) throw new Error('No hay archivos .xlsx que leer');
  const salida = opcion('--salida') ?? SALIDA_POR_OMISION;

  const coa = JSON.parse(
    readFileSync(join(__dirname, 'data', 'fpa-coa.json'), 'utf8'),
  ) as CatalogoCoa;
  // Viajes › Viajes es de la plataforma (los viajes calculados), no del COA
  const ctx: ContextoCatalogo = {
    categorias: coa.categorias.map((c) => ({
      nombre: c.nombre,
      clasificaciones: [
        ...c.clasificaciones.map((k) => k.nombre),
        ...(clave(c.nombre) === clave('Viajes') ? ['Viajes'] : []),
      ],
    })),
    pares: coa.pares,
  };

  const avisosGenerales: string[] = [];
  const todos = archivos.map((ruta) => {
    const buffer = readFileSync(ruta);
    // cellStyles: sin él, SheetJS no lee qué filas están ocultas
    const libro = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: true,
      cellStyles: true,
      cellDates: false,
    });
    const { leida, motivo } = hojaPrincipal(libro, basename(ruta));
    if (!leida) {
      avisosGenerales.push(
        `${basename(ruta)}: no trae el bloque 2027; se omite (${motivo})`,
      );
    }
    return { ruta, md5: createHash('md5').update(buffer).digest('hex'), leida };
  });
  const leidos = todos.filter(
    (l): l is { ruta: string; md5: string; leida: HojaLeida } =>
      l.leida !== null,
  );
  if (leidos.length === 0) {
    throw new Error(
      `Ningún archivo trae el bloque 2027: ${avisosGenerales.join(' · ')}`,
    );
  }

  const problemas: string[] = [];
  const inflaciones = new Set(
    leidos.map((l) => l.leida.inflacion?.pct).filter((x) => x !== undefined),
  );
  if (inflaciones.size > 1) {
    problemas.push(
      `los archivos traen inflaciones distintas: ${[...inflaciones].join(', ')}`,
    );
  }
  const usd = dolarDeLasFormulas(leidos.map((l) => l.leida));
  const archivosB27: ArchivoB27[] = leidos.map((l) => {
    const corto = basename(l.ruta)
      .replace(/\.xlsx$/i, '')
      .replace(/^\d{4}\s+\d{2}\s+/, '')
      .trim();
    const params = { inflacion: l.leida.inflacion, usd };
    return lineasDeHoja(l.leida, basename(l.ruta), corto, params, ctx);
  });

  // Un área en dos archivos u hojas se cargaría dos veces
  const vistasArea = new Map<string, string>();
  for (const a of archivosB27) {
    for (const s of a.secciones.filter((x) => x.lineas.length > 0)) {
      const previa = vistasArea.get(s.area);
      if (previa)
        problemas.push(
          `${s.area} viene en dos lugares (${previa} y ${a.archivo}); deja solo uno`,
        );
      vistasArea.set(s.area, a.archivo);
    }
  }
  // Duplicados: mismo concepto y mismos montos en la misma área
  for (const a of archivosB27) {
    for (const s of a.secciones) {
      const vistas = new Map<string, number>();
      for (const ln of s.lineas) {
        const k = `${clave(ln.concepto)}|${ln.meses.map((m) => `${m.mes}:${m.monto}`).join(',')}`;
        const previa = vistas.get(k);
        if (previa) {
          avisosGenerales.push(
            `${s.area}: "${ln.concepto}" está dos veces con los mismos montos (filas ${previa} y ${ln.fila}); se cargan las dos`,
          );
        }
        vistas.set(k, ln.fila);
      }
    }
  }
  // Negativos donde la clasificación no los acepta
  const aceptaNegativos = new Set(
    coa.categorias.flatMap((c) =>
      c.clasificaciones
        .filter((k) => k.acepta_negativos)
        .map((k) => `${clave(c.nombre)}|${clave(k.nombre)}`),
    ),
  );
  for (const a of archivosB27) {
    for (const s of a.secciones) {
      for (const ln of s.lineas) {
        if (!ln.meses.some((m) => Number(m.monto) < 0)) continue;
        if (ln.clasificacion === POR_CLASIFICAR) continue;
        if (
          !aceptaNegativos.has(
            `${clave(ln.categoria)}|${clave(ln.clasificacion)}`,
          )
        ) {
          problemas.push(
            `${s.area}, fila ${ln.fila} "${ln.concepto}": monto negativo en ${ln.categoria} › ${ln.clasificacion}, que no acepta negativos`,
          );
        }
      }
    }
  }

  const resultado = {
    generado: new Date().toISOString(),
    fuente: leidos.map((l) => ({
      archivo: basename(l.ruta),
      md5: l.md5,
      hoja: l.leida.hoja,
    })),
    parametros: {
      inflacion_pct:
        inflaciones.size === 1 ? Number([...inflaciones][0]).toFixed(3) : null,
      usd: usd ? String(usd) : null,
    },
    archivos: archivosB27,
    avisos: avisosGenerales,
    problemas: [...problemas, ...archivosB27.flatMap((a) => a.problemas)],
  };
  mkdirSync(dirname(salida), { recursive: true });
  writeFileSync(salida, `${JSON.stringify(resultado, null, 2)}\n`, 'utf8');

  // Reporte
  const log = (s: string) => console.log(s);
  log(
    `Parámetros: inflación ${resultado.parametros.inflacion_pct ?? '—'}%, USD ${resultado.parametros.usd ?? '—'}`,
  );
  for (const a of archivosB27) {
    log(`\n${a.archivo} (hoja ${a.hoja})`);
    for (const s of a.secciones) {
      const como = {
        ninguna: 'cuadra',
        redondeo: `diferencia ${s.diferencia}, de redondeo`,
        explicada: `diferencia ${s.diferencia}, explicada abajo`,
        sin_explicar: `diferencia ${s.diferencia} SIN EXPLICAR`,
      }[s.tipo_diferencia];
      log(
        `  ${s.area}: ${s.lineas.length} líneas · archivo ${s.total_archivo} · líneas ${s.total_lineas} · ${como}`,
      );
    }
    for (const d of a.diferencias) {
      log(
        `    ≠ ${d.area}, fila ${d.fila} "${d.etiqueta}": archivo ${d.archivo}, sus filas ${d.lineas} (${d.diferencia}). ${d.motivo}`,
      );
    }
    for (const x of a.avisos) log(`    · ${x}`);
  }
  const todas = archivosB27.flatMap((a) =>
    a.secciones.flatMap((s) => s.lineas.map((l) => ({ ...l, area: s.area }))),
  );
  const porComo = new Map<string, number>();
  for (const l of todas) porComo.set(l.como, (porComo.get(l.como) ?? 0) + 1);
  log(
    `\nLíneas: ${todas.length} (${[...porComo.entries()].map(([k, n]) => `${k} ${n}`).join(', ')})`,
  );
  const supuestos = todas.filter(
    (l) => l.como !== 'coa' && l.como !== 'por_omision',
  );
  if (supuestos.length) {
    log('Supuestos y lo que hay que decidir con Laura:');
    for (const l of supuestos) {
      log(
        `  · ${l.area}, fila ${l.fila} "${l.concepto}" › ${l.categoria} › ${l.clasificacion} [${l.como}]${l.notas.length ? `: ${l.notas.join('; ')}` : ''} (${l.total})`,
      );
    }
  }
  for (const x of avisosGenerales) log(`· ${x}`);
  if (resultado.problemas.length) {
    log(`\nProblemas (${resultado.problemas.length}):`);
    for (const p of resultado.problemas) log(`  ✗ ${p}`);
    process.exitCode = 1;
  }
  log(`\nEscrito: ${salida}`);
}

try {
  main();
} catch (err) {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
}

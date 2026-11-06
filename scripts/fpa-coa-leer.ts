/**
 * FP&A (bloque C, C1) — lee el Chart of Accounts de A3T y escribe el catálogo
 * que carga `fpa:catalogo` (scripts/data/fpa-coa.json).
 *
 * Se corre en la computadora donde está el Excel; el JSON se sube al repo, así
 * que en prod no hace falta el archivo. La lógica vive en
 * src/fpa/carga/coa.ts, con pruebas.
 *
 * USO:
 *   npm run fpa:coa-leer -- "<ruta>/3. A3T_CHART_OF_ACCOUNTS_2025.xlsx"
 *   (sin ruta, busca el de documentation/fpa/)
 */
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import * as XLSX from 'xlsx';
import { construirCatalogo, type FilaCoa } from '../src/fpa/carga/coa';

const HOJA = 'OACT_SAP_2025';
const SALIDA = join(__dirname, 'data', 'fpa-coa.json');
const POR_OMISION = resolve(
  __dirname,
  '../../documentation/fpa/3. A3T_CHART_OF_ACCOUNTS_2025.xlsx',
);

// Las celdas sin dato del COA traen 0 (resultado de fórmula): cuentan como vacías
const texto = (v: unknown): string | null =>
  (typeof v === 'string' || typeof v === 'number') &&
  v !== '' &&
  v !== 0 &&
  v !== '0'
    ? String(v)
    : null;

function main() {
  const ruta = process.argv[2] ?? POR_OMISION;
  const buffer = readFileSync(ruta);
  const libro = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const hoja = libro.Sheets[HOJA];
  if (!hoja) {
    throw new Error(
      `El archivo no trae la hoja ${HOJA}: ${libro.SheetNames.join(', ')}`,
    );
  }
  const renglones = XLSX.utils.sheet_to_json<unknown[]>(hoja, {
    header: 1,
    blankrows: false,
    defval: null,
  });
  // Fila 2: Código de cuenta | … | Loading Factor Code (E) | … | CECO_COA (I)
  // | SZ | departamento (K) | Descripción 2 (L) | Descripción 3 (M)
  const encabezado = (renglones[1] ?? []).map((v) =>
    typeof v === 'string' ? v : '',
  );
  const esperado = ['departamento', 'Descripción 2', 'Descripción 3'];
  if (!esperado.every((e, i) => encabezado[10 + i]?.trim() === e)) {
    throw new Error(
      `Los encabezados K:M no son ${esperado.join(', ')}: ${encabezado.slice(10, 13).join(', ')}`,
    );
  }
  const filas: FilaCoa[] = renglones
    .slice(2)
    .filter((r) => r[0] !== null && r[0] !== undefined)
    .map((r) => ({
      cuenta: String(r[0]),
      lfc: texto(r[4]),
      ceco: texto(r[8]),
      departamento: texto(r[10]),
      desc2: texto(r[11]),
      desc3: texto(r[12]),
    }));
  const catalogo = construirCatalogo(filas);
  const salida = {
    fuente: {
      archivo: basename(ruta),
      md5: createHash('md5').update(buffer).digest('hex'),
      hoja: HOJA,
      cuentas: filas.length,
    },
    ...catalogo,
  };
  mkdirSync(dirname(SALIDA), { recursive: true });
  writeFileSync(SALIDA, `${JSON.stringify(salida, null, 2)}\n`, 'utf8');

  const clasificaciones = catalogo.categorias.reduce(
    (n, c) => n + c.clasificaciones.length,
    0,
  );
  console.log(
    `Leído: ${basename(ruta)} (${filas.length} cuentas, md5 ${salida.fuente.md5})`,
  );
  console.log(
    `Departamentos: ${catalogo.departamentos.length} · categorías: ${catalogo.categorias.length} · clasificaciones: ${clasificaciones}`,
  );
  for (const d of catalogo.departamentos) {
    console.log(
      `  ${d.centro_costos.padEnd(9)} ${d.nombre}: ${d.cuentas} cuentas, ${catalogo.pares[d.nombre]?.length ?? 0} parejas`,
    );
  }
  for (const a of catalogo.avisos) console.log(`  · ${a}`);
  console.log(`Escrito: ${SALIDA}`);
}

try {
  main();
} catch (err) {
  console.error('❌', err instanceof Error ? err.message : err);
  process.exit(1);
}

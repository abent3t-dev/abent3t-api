/**
 * FP&A (bloque C, C1) — catálogo desde el Chart of Accounts (COA) de A3T.
 *
 * Lee las cuentas de gasto (primer dígito 6) de la hoja OACT_SAP_2025 que
 * tienen centro de costos de gastos generales (GSGAD…), de NAES (GMTOM…) o de
 * GE (GGEEM…), y arma (FPA.md, "Reunión del 26-oct", punto 3):
 *   - los departamentos de FP&A con su centro de costos;
 *   - categorías (Descripción 2) y clasificaciones (Descripción 3, sin el
 *     beneficiario: "Autos Comercial" es Autos, y el departamento de la línea
 *     dice a quién se carga);
 *   - qué parejas categoría › clasificación le da el COA a cada departamento,
 *     para que cada área vea solo las suyas (decisión 16).
 *
 * Lógica pura, sin Excel ni base: la usan scripts/fpa-coa-leer.ts (Excel ›
 * JSON) y el lector del B-27. Las pruebas están en coa.spec.ts.
 */
import { clave, limpiar, nombreCanonico } from './normalizar';

export interface FilaCoa {
  cuenta: string;
  /** "Loading Factor Code" (columna E): el centro de costos que usa David. */
  lfc: string | null;
  /** CECO_COA (columna I): viene cuando E está vacía (cuentas de NAES). */
  ceco: string | null;
  departamento: string | null;
  desc2: string | null;
  desc3: string | null;
}

export interface CatalogoCoa {
  departamentos: Array<{
    nombre: string;
    /** GSGAD…; en NAES y GE, el prefijo (cada categoría trae el suyo). */
    centro_costos: string;
    cuentas: number;
  }>;
  categorias: Array<{
    nombre: string;
    orden: number;
    clasificaciones: Array<{ nombre: string; acepta_negativos: boolean }>;
  }>;
  /** Por departamento: las parejas [categoría, clasificación] que le da el COA. */
  pares: Record<string, Array<[string, string]>>;
  avisos: string[];
}

/**
 * Departamentos que el COA pone al final de las clasificaciones de Beneficios
 * y Capacitación (RH): "Vales de Restaurante Dirección General",
 * "Capacitación › Legal". Los de dos palabras van primero.
 */
export const BENEFICIARIOS = [
  'Operación Tabasco',
  'Recursos Humanos',
  'Dirección General',
  'Servicios Generales',
  'Cuarto Tren',
  'Contraloría',
  'Finanzas',
  'Legal',
  'Comercial',
  'Medición',
  'Operación',
  'Seguridad',
  'Compras',
  'IT',
  'Mem',
  'GEV',
];

/** Claves de departamento que usa Servicios Generales como clasificación. */
export const CODIGOS_BENEFICIARIO = [
  'RHG',
  'DIG',
  'FIG',
  'LEG',
  'COG',
  'CMG',
  'OPG',
  'MEG',
  'CTG',
  'GEM',
  'ITG',
];

/** Beneficiario › departamento de FP&A (los demás no tienen departamento). */
export const DEPARTAMENTO_DEL_BENEFICIARIO: Record<string, string> = {
  'Recursos Humanos': 'Recursos Humanos',
  'Dirección General': 'Dirección General',
  'Servicios Generales': 'Servicios Generales',
  'Cuarto Tren': 'Cuarto Tren',
  Contraloría: 'Contraloría',
  Finanzas: 'Finanzas',
  Legal: 'Legal',
  Comercial: 'Comercial',
  Medición: 'Medición',
  Operación: 'Operación',
  Compras: 'Compras',
  IT: 'IT',
  RHG: 'Recursos Humanos',
  DIG: 'Dirección General',
  FIG: 'Finanzas',
  LEG: 'Legal',
  OPG: 'Operación',
  MEG: 'Medición',
  ITG: 'IT',
};

const CATEGORIAS_CON_BENEFICIARIO = new Set([
  clave('Beneficios'),
  clave('Capacitación'),
]);

/**
 * Quita el beneficiario de una clasificación del COA. Solo en Beneficios y
 * Capacitación (así "Asesoría Legal" no pierde "Legal") y en las claves de
 * Servicios Generales (RHG, DIG…), que solo aparecen solas. Si no queda nada,
 * la clasificación es la categoría ("Capacitación › Legal" es Capacitación).
 */
export function quitarBeneficiario(
  categoria: string,
  clasificacion: string,
): { clasificacion: string; beneficiario: string | null } {
  const cls = limpiar(clasificacion);
  const codigo = CODIGOS_BENEFICIARIO.find((c) => clave(c) === clave(cls));
  if (codigo)
    return { clasificacion: limpiar(categoria), beneficiario: codigo };
  if (!CATEGORIAS_CON_BENEFICIARIO.has(clave(categoria))) {
    return { clasificacion: cls, beneficiario: null };
  }
  const palabras = cls.split(' ');
  for (const b of BENEFICIARIOS) {
    const n = b.split(' ').length;
    if (palabras.length < n) continue;
    if (clave(palabras.slice(-n).join(' ')) !== clave(b)) continue;
    const resto = palabras.slice(0, -n).join(' ');
    return { clasificacion: resto || limpiar(categoria), beneficiario: b };
  }
  return { clasificacion: cls, beneficiario: null };
}

/** Orden del reporte: las de siempre primero, luego lo propio de cada área. */
const ORDEN_PREFERIDO = [
  'Servicios Profesionales',
  'Consultorías',
  'Auditorías',
  'Comunicaciones',
  'Otras Comunicaciones',
  'Arrendamientos',
  'Cuotas y Suscripciones',
  'Otros',
  'Viajes',
  'Eventos',
  'Servicios Administrados y Licencias',
  'Instalaciones Técnicas',
  'Derechos y Permisos',
  'Salarios',
  'Beneficios',
  'Administración Nómina',
  'Capacitación',
  'Gastos de Oficina',
  'Estacionamiento',
  'Mantenimiento',
  'Impresoras',
  'Papelería',
  'Mensajería',
  'Gastos Autos',
  'Litigios',
  'Fiduciarios',
  'Energía',
  'Controles Volumétricos',
  'Seguridad Planta',
  'Mantenimiento Planta',
  'Gastos Generales Planta',
  'Seguros',
  'Amparo tarifas porteo',
].map(clave);

/**
 * Clasificaciones que aceptan montos negativos además de los descuentos: las
 * que llevan los ajustes D-5 (arrendamiento, NIF D-5) en los F2/B27
 * (NOTAS_IMPORTADOR, regla 9). Supuesto para confirmar con Laura: el COA no
 * trae una clasificación propia para el ajuste.
 */
export const NEGATIVOS_D5: Array<[string, string]> = [
  ['Beneficios', 'Autos'], // RH, Detailed!56 "D-5 Automóviles"
  ['Arrendamientos', 'Renta Oficina'], // RH (SSGG), Detailed!175 "Renta Oficina D-5"
  ['Arrendamientos', 'Renta de Equipo de Cómputo'], // RH (IT), Detailed!270 "Equipo de Cómputo D-5"
  ['Gastos Generales Planta', 'Autos'], // Planta, 2026-2027!334 "arrendamientos vehículos D-5"
];

const centroDe = (f: FilaCoa): string | null => {
  const v = limpiar(f.lfc) || limpiar(f.ceco);
  return v && !v.startsWith('#') ? v : null;
};

/** Departamento de FP&A de una cuenta, o null si no es de gasto de FP&A. */
function departamentoDe(f: FilaCoa): { nombre: string; centro: string } | null {
  if (!String(f.cuenta).startsWith('6')) return null;
  const centro = centroDe(f);
  if (!centro) return null;
  if (centro.startsWith('GMTOM')) return { nombre: 'NAES', centro: 'GMTOM' };
  if (centro.startsWith('GGEEM')) return { nombre: 'GE', centro: 'GGEEM' };
  if (centro.startsWith('GSGAD')) {
    const nombre = limpiar(f.departamento);
    return nombre ? { nombre, centro } : null;
  }
  return null;
}

/** Arma el catálogo de FP&A con las filas de la hoja OACT_SAP_2025. */
export function construirCatalogo(filas: FilaCoa[]): CatalogoCoa {
  const avisos: string[] = [];
  const deptos = new Map<
    string,
    { nombre: string; centros: Map<string, number>; cuentas: number }
  >();
  // Categorías por clave, con sus clasificaciones por clave (en orden de aparición)
  const cats = new Map<
    string,
    { nombre: string; aparicion: number; clasif: Map<string, string> }
  >();
  const pares = new Map<string, Map<string, [string, string]>>();
  const sinDesc3 = new Map<string, number>();
  let aparicion = 0;

  const ordenadas = [...filas].sort((a, b) =>
    String(a.cuenta).localeCompare(String(b.cuenta)),
  );
  for (const f of ordenadas) {
    const d = departamentoDe(f);
    if (!d) continue;
    const dep = deptos.get(d.nombre) ?? {
      nombre: d.nombre,
      centros: new Map<string, number>(),
      cuentas: 0,
    };
    dep.cuentas += 1;
    dep.centros.set(d.centro, (dep.centros.get(d.centro) ?? 0) + 1);
    deptos.set(d.nombre, dep);

    const categoria = nombreCanonico(f.desc2);
    const desc3 = limpiar(f.desc3);
    if (!categoria || !desc3) {
      sinDesc3.set(d.nombre, (sinDesc3.get(d.nombre) ?? 0) + 1);
      continue;
    }
    const clasificacion = nombreCanonico(
      quitarBeneficiario(categoria, desc3).clasificacion,
    );
    const kc = clave(categoria);
    const cat = cats.get(kc) ?? {
      nombre: categoria,
      aparicion: aparicion++,
      clasif: new Map<string, string>(),
    };
    if (!cat.clasif.has(clave(clasificacion))) {
      cat.clasif.set(clave(clasificacion), clasificacion);
    }
    cats.set(kc, cat);
    const delDepto = pares.get(d.nombre) ?? new Map<string, [string, string]>();
    delDepto.set(`${kc}|${clave(clasificacion)}`, [
      cat.nombre,
      cat.clasif.get(clave(clasificacion)) as string,
    ]);
    pares.set(d.nombre, delDepto);
  }

  for (const [nombre, n] of sinDesc3) {
    avisos.push(
      `${nombre}: ${n} cuenta(s) sin Descripción 2 o 3; no entran al catálogo`,
    );
  }

  const negativos = new Set(
    NEGATIVOS_D5.map(([c, k]) => `${clave(c)}|${clave(k)}`),
  );
  const rango = (k: string, n: number) => {
    const i = ORDEN_PREFERIDO.indexOf(k);
    return i >= 0 ? i : ORDEN_PREFERIDO.length + n;
  };
  const categorias = [...cats.entries()]
    .sort(([ka, a], [kb, b]) => rango(ka, a.aparicion) - rango(kb, b.aparicion))
    .map(([kc, c], i) => ({
      nombre: c.nombre,
      orden: i + 1,
      clasificaciones: [...c.clasif.entries()].map(([kk, nombre]) => ({
        nombre,
        acepta_negativos:
          kk.startsWith('descuento') || negativos.has(`${kc}|${kk}`),
      })),
    }));

  const departamentos = [...deptos.values()]
    .map((d) => {
      // Si un departamento trae más de un centro (no debería), manda el más usado
      const [centro] = [...d.centros.entries()].sort((a, b) => b[1] - a[1])[0];
      if (d.centros.size > 1) {
        avisos.push(
          `${d.nombre}: varios centros de costos (${[...d.centros.keys()].join(', ')}); se toma ${centro}`,
        );
      }
      return { nombre: d.nombre, centro_costos: centro, cuentas: d.cuentas };
    })
    // Gastos generales por centro (GSGAD001…), después NAES y GE
    .sort((a, b) => {
      const grupo = (c: string) =>
        ['GSGAD', 'GMTOM', 'GGEEM'].indexOf(c.slice(0, 5));
      return (
        grupo(a.centro_costos) - grupo(b.centro_costos) ||
        a.centro_costos.localeCompare(b.centro_costos)
      );
    });

  return {
    departamentos,
    categorias,
    pares: Object.fromEntries(
      [...pares.entries()].map(([d, m]) => [d, [...m.values()]]),
    ),
    avisos,
  };
}

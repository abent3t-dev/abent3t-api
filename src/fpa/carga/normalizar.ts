/**
 * FP&A (bloque C) — normalización de nombres para comparar el Chart of
 * Accounts, los Excel de Laura y el catálogo de la base.
 *
 * - `clave` compara sin acentos, sin mayúsculas, sin signos y sin palabras
 *   vacías ("de", "y"…): "Vales Restaurante" = "Vales de Restaurante",
 *   "Comunicaciónes" = "Comunicaciones", "Renta de autos " = "Renta de autos".
 * - `limpiar` quita espacios de más (la base no los acepta: CHECK de 0021).
 * - `nombreCanonico` corrige la ortografía de los nombres del COA que se
 *   enseñan en pantalla (acentos y erratas). Solo cambia la forma de
 *   escribirlo: la clave es la misma, así que no crea otra clasificación.
 */

const PALABRAS_VACIAS = new Set([
  'a',
  'al',
  'con',
  'de',
  'del',
  'e',
  'el',
  'en',
  'la',
  'las',
  'los',
  'para',
  'por',
  'y',
]);

export const sinAcentos = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Clave de comparación: sin acentos, mayúsculas, signos ni palabras vacías. */
export function clave(s: string | null | undefined): string {
  if (!s) return '';
  return sinAcentos(String(s))
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .split(' ')
    .filter((w) => w && !PALABRAS_VACIAS.has(w))
    .join(' ');
}

/** Sin espacios al inicio, al final ni repetidos. */
export const limpiar = (s: string | null | undefined): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Ortografía de los nombres del COA (y de los Excel) que se enseñan en
 * pantalla. La llave es la `clave` del nombre como viene; el valor, cómo se
 * escribe. Incluye los tres "O&M Dep …" de las cuentas de provisión de NAES,
 * que son la misma categoría que "O&M Departamento de …" (mismo centro de
 * costos, GMTOM018 a 020).
 */
const ORTOGRAFIA: Record<string, string> = {
  [clave('Administración Nomina')]: 'Administración Nómina',
  [clave('No Deducibles')]: 'No deducibles',
  [clave('Nutriologa')]: 'Nutrióloga',
  [clave('O&M Dep Administración')]: 'O&M Departamento de Administración',
  [clave('O&M Dep de Mantenimeinto')]: 'O&M Departamento de Mantenimiento',
  [clave('O&M Dep de Operación')]: 'O&M Departamento de Operación',
  [clave('O&M Informatica')]: 'O&M Informática',
  [clave('otros')]: 'Otros',
  [clave('Papeleria')]: 'Papelería',
  [clave('Psícologa')]: 'Psicóloga',
  [clave('Renta de Equipo de Computo')]: 'Renta de Equipo de Cómputo',
  [clave('Renta de Vehiculos')]: 'Renta de Vehículos',
  [clave('Vehiculos')]: 'Vehículos',
  [clave('Viaticos')]: 'Viáticos',
};

/** Nombre como se guarda: limpio y con la ortografía corregida. */
export function nombreCanonico(s: string | null | undefined): string {
  const limpio = limpiar(s);
  return ORTOGRAFIA[clave(limpio)] ?? limpio;
}

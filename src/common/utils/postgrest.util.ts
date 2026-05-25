/**
 * Sanitiza un string de búsqueda antes de interpolarlo en filtros PostgREST
 * (`.or()`, `.ilike()`, etc.).
 *
 * PostgREST usa `,` `(` `)` como separadores dentro de `.or(...)`, y `*` como
 * wildcard. Si un atacante envía `foo,is_active.eq.false`, puede romper el
 * filtro y cambiar la semántica de la consulta para leer/manipular más datos.
 *
 * Esta función:
 *   - elimina caracteres que rompen la sintaxis del DSL: , ( ) \ *
 *   - también elimina % y _ (wildcards de SQL LIKE) para evitar matches no
 *     deseados — si necesitas búsqueda con wildcard, deja que el llamador
 *     envuelva el valor en `%foo%`.
 *   - limita longitud a 100 chars (mismo límite del DTO, defensa en profundidad)
 *
 * @returns string sanitizado, o '' si el input es nulo/no-string.
 */
export function sanitizeSearchTerm(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[,()\\*%_]/g, '').trim().slice(0, 100);
}

/**
 * Construye el filtro `.or()` para PostgREST a partir de un término de
 * búsqueda y los campos donde buscarlo. Sanitiza el término primero.
 *
 * @returns el string para `.or(...)`, o null si no hay término válido.
 */
export function buildIlikeOrFilter(
  searchTerm: unknown,
  fields: string[],
): string | null {
  const safe = sanitizeSearchTerm(searchTerm);
  if (!safe || fields.length === 0) return null;
  return fields.map((f) => `${f}.ilike.%${safe}%`).join(',');
}

/**
 * Orden de cualquier historial de estatus de Maximo (POSTATUS,
 * CONTRACTSTATUS, PRSTATUS): CHANGEDATE ascendente (nulos al final). Maximo
 * NO devuelve las filas ordenadas y hay cambios en el mismo segundo: el
 * desempate es el id monótono de la fila (POSTATUSID / CONTRACTSTATUSID /
 * PRSTATUSID).
 *
 * H11 (2026-10-05): lo comparten el mapper (lo que se guarda) y el detalle
 * de contrato (lo que se lee del raw), para que las dos listas no vuelvan a
 * salir en orden distinto en la misma pantalla.
 */
export interface StatusOrderKey {
  /** CHANGEDATE tal como llega (ISO); null = sin fecha. */
  changeDate: string | null;
  /** Id monótono de la fila; null = sin id (no desempata). */
  id: number | null;
}

export function compareStatusChange(
  a: StatusOrderKey,
  b: StatusOrderKey,
): number {
  if (a.changeDate !== b.changeDate) {
    if (a.changeDate === null) return 1;
    if (b.changeDate === null) return -1;
    return a.changeDate < b.changeDate ? -1 : 1;
  }
  if (a.id !== null && b.id !== null && a.id !== b.id) {
    return a.id - b.id;
  }
  return 0;
}

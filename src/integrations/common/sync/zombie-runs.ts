/**
 * F2 (post-deploy 2026-09-25) — Corridas de sync "zombie" al arrancar.
 *
 * El mutex de corridas vive en memoria, así que al arrancar el proceso
 * cualquier corrida `running` que empezó ANTES de este arranque quedó muerta
 * (crash o redeploy con `--force-recreate` a media corrida). Antes solo se
 * marcaban las de más de 30 min y la que cortaba el deploy se quedaba en
 * `running`. Una corrida de este mismo proceso no puede existir todavía en
 * `onModuleInit` (los crons arrancan después), así que el corte es la hora
 * de arranque del proceso.
 */
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000);

/** Hora de arranque del proceso: corte de la limpieza de zombies. */
export function zombieRunCutoff(): Date {
  return PROCESS_STARTED_AT;
}

export const ZOMBIE_RUN_SUMMARY =
  'Marcada como fallida al reiniciar el servidor (zombie cleanup)';

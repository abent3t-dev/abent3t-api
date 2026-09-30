import { ArrayNotEmpty, ArrayUnique, IsArray, IsUUID } from 'class-validator';

/**
 * H3 (2026-09-29) — Nuevo orden de la cadena del comité: TODOS los niveles
 * (activos e inactivos), del primero al último. Se aplica en una sola
 * transacción porque `orden` es único.
 */
export class ReorderApprovalLevelsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids!: string[];
}

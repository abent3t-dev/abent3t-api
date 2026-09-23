import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * D4 (2026-09-23): `year=2025` filtra por año calendario. Decorador
 * compuesto para reutilizarlo en los DTOs de los listados y resúmenes.
 */
export function IsYearQuery(): PropertyDecorator {
  return (target, key) => {
    IsOptional()(target, key);
    Transform(({ value }) =>
      value === '' || value === undefined || value === null
        ? undefined
        : Number(value),
    )(target, key);
    IsInt()(target, key);
    Min(2000)(target, key);
    Max(2100)(target, key);
  };
}

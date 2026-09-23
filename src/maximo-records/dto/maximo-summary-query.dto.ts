import { IsYearQuery } from '../../common/dto/year-query.util';

/** D4 (2026-09-23): `?year=` acota el resumen de Maximo (pies). */
export class MaximoSummaryQueryDto {
  @IsYearQuery()
  year?: number;
}

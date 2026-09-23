import { IsYearQuery } from '../../common/dto/year-query.util';

/** D4 (2026-09-23): `?year=` acota el resumen de SAP (pies y montos). */
export class SapSummaryQueryDto {
  @IsYearQuery()
  year?: number;
}

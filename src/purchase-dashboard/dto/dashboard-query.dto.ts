import { IsYearQuery } from '../../common/dto/year-query.util';

/** D4 (2026-09-23): `?year=2025` acota tarjetas, pies y montos a ese año. */
export class DashboardQueryDto {
  @IsYearQuery()
  year?: number;
}

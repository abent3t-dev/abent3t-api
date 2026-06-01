import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { calculateBusinessDays } from '../utils/business-days';

/**
 * Servicio inyectable que cachea los `holidays` activos en memoria y expone
 * `calculate(start, end)`. Cache TTL configurable (default 1 hora). El set
 * de holidays cambia muy rara vez, así que el cache evita una query por
 * cálculo. Si se necesita invalidar manualmente, llamar `invalidateCache()`.
 *
 * Reemplaza la RPC PostgreSQL `calculate_business_days(start_date, end_date)`
 * — ver MIGRATION_AUDIT.md §K-2.
 */
@Injectable()
export class BusinessDaysService {
  private holidaysCache: string[] | null = null;
  private cacheExpiresAt = 0;
  private readonly cacheTtlMs = 60 * 60 * 1000; // 1 hora

  constructor(private readonly prisma: PrismaService) {}

  private async loadHolidays(): Promise<string[]> {
    const now = Date.now();
    if (this.holidaysCache && now < this.cacheExpiresAt) {
      return this.holidaysCache;
    }
    const rows = await this.prisma.holidays.findMany({
      where: { is_active: true },
      select: { holiday_date: true },
    });
    this.holidaysCache = rows.map((r) => r.holiday_date.toISOString().slice(0, 10));
    this.cacheExpiresAt = now + this.cacheTtlMs;
    return this.holidaysCache;
  }

  /** Invalida el cache (llamar cuando se modifique la tabla `holidays`). */
  invalidateCache(): void {
    this.holidaysCache = null;
    this.cacheExpiresAt = 0;
  }

  async calculate(
    start: Date | string,
    end: Date | string,
  ): Promise<number> {
    const holidays = await this.loadHolidays();
    return calculateBusinessDays(start, end, holidays);
  }
}

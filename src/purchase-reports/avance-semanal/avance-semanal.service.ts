import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AvanceSemanalDto } from '../dto/avance-semanal.dto';
import { buildAvanceData, loadAvanceRows } from './avance-semanal.data';
import {
  type AvanceData,
  type AvancePage,
  type AvanceReporte,
  avanceDefiniciones,
  buildAvancePage,
  fuentesDelReporte,
  isoDay,
  lastCompleteWeek,
  mondayOf,
  parseDay,
  weeksBetween,
} from './avance-semanal.engine';
import { renderAvancePdf } from './avance-semanal.pdf';

/**
 * H1 (reunión con Ingrid 2026-09-29) — "Reporte de avance semanal" en un
 * clic: JSON de la página, PDF de una semana y el acumulado (una página por
 * semana). Carga los datos UNA vez por petición y el motor rebana por semana.
 * Solo lectura.
 *
 * I3 (go-live 2026-09-30): por defecto (`ambos`) cada semana trae una página
 * de Maximo y una de SAP, homologadas. El acumulado va por sección: todas las
 * semanas de Maximo (de la más nueva a la más vieja) y luego las de SAP; el
 * índice son los marcadores del PDF (sin páginas extra).
 */

/** Tope del acumulado: poco más de un año de semanas. */
const MAX_WEEKS = 60;

@Injectable()
export class AvanceSemanalService {
  constructor(private readonly prisma: PrismaService) {}

  async loadData(): Promise<AvanceData> {
    return buildAvanceData(await loadAvanceRows(this.prisma));
  }

  /**
   * JSON de una semana (default: la última completa). Con `ambos`, las dos
   * páginas (Maximo y SAP) en `paginas`; con una fuente, la página sola.
   */
  async getSemana(dto: AvanceSemanalDto) {
    const [lunes] = this.resolveWeeks({ semana: dto.semana });
    const data = await this.loadData();
    const now = new Date();
    const paginas = fuentesDelReporte(this.reporte(dto)).map((fuente) => ({
      ...buildAvancePage(data, lunes, fuente, now),
      definiciones: avanceDefiniciones(fuente),
    }));
    return paginas.length === 1 ? paginas[0] : { paginas };
  }

  /**
   * Páginas del PDF: una semana o el rango `desde`–`hasta` (más nueva
   * primero), una sección por fuente (I3: Maximo y luego SAP).
   */
  async getPaginas(dto: AvanceSemanalDto): Promise<AvancePage[]> {
    const weeks = this.resolveWeeks(dto);
    const data = await this.loadData();
    const now = new Date();
    return fuentesDelReporte(this.reporte(dto)).flatMap((fuente) =>
      weeks.map((lunes) => buildAvancePage(data, lunes, fuente, now)),
    );
  }

  async buildPdf(
    dto: AvanceSemanalDto,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const pages = await this.getPaginas(dto);
    const buffer = await renderAvancePdf(pages);
    const reporte = this.reporte(dto);
    const suffix =
      reporte === 'ambos'
        ? ''
        : reporte === 'todas'
          ? '_combinado'
          : `_${reporte}`;
    const lunes = pages.map((p) => p.semana.lunes).sort();
    const oldest = lunes[0];
    const newest = lunes[lunes.length - 1];
    const filename =
      oldest === newest
        ? `reporte_avance_semanal_${newest}${suffix}.pdf`
        : `reporte_avance_semanal_${oldest}_al_${newest}${suffix}.pdf`;
    return { buffer, filename };
  }

  private reporte(dto: AvanceSemanalDto): AvanceReporte {
    return dto.fuente ?? 'ambos';
  }

  /**
   * Semanas pedidas (lunes UTC, la más nueva primero). Nunca después de la
   * semana en curso; `desde` sin `hasta` = hasta la última semana completa.
   */
  resolveWeeks(dto: AvanceSemanalDto, now = new Date()): Date[] {
    const current = mondayOf(now);
    const clamp = (d: Date) =>
      d.getTime() > current.getTime() ? current : mondayOf(d);
    const parse = (value: string) => {
      try {
        return parseDay(value);
      } catch {
        throw new BadRequestException(`Fecha inválida: ${value}`);
      }
    };
    if (!dto.desde && !dto.hasta) {
      return [dto.semana ? clamp(parse(dto.semana)) : lastCompleteWeek(now)];
    }
    const hasta = dto.hasta ? clamp(parse(dto.hasta)) : lastCompleteWeek(now);
    const desde = dto.desde ? clamp(parse(dto.desde)) : hasta;
    if (desde.getTime() > hasta.getTime()) {
      throw new BadRequestException(
        `El rango es inválido: ${isoDay(desde)} es después de ${isoDay(hasta)}`,
      );
    }
    const weeks = weeksBetween(desde, hasta);
    if (weeks.length > MAX_WEEKS) {
      throw new BadRequestException(
        `El acumulado admite hasta ${MAX_WEEKS} semanas`,
      );
    }
    return weeks;
  }
}

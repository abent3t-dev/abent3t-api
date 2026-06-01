import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BaseCrudPrismaService } from '../../common/services/base-crud-prisma.service';
import { CreatePerdidaFiscalDto } from './dto/create-perdida-fiscal.dto';
import { UpdatePerdidaFiscalDto } from './dto/update-perdida-fiscal.dto';
import { CreateAmortizacionDto } from './dto/create-amortizacion.dto';

export interface FiscalLossRow {
  id: string;
  ejercicio: number;
  fecha_declaracion: string;
  fecha_vencimiento: string;
  monto_original: number;
  monto_actualizado: number;
  amortizado: number;
  saldo_pendiente: number;
  factor_actualizacion: number;
  status: string;
  notes: string | null;
  created_by: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface AmortizationRow {
  id: string;
  fiscal_loss_id: string;
  ejercicio_aplicacion: number;
  monto_amortizado: number;
  declaracion_id: string | null;
  notes: string | null;
  created_by: string | null;
  is_active: boolean;
  created_at: string;
}

@Injectable()
export class PerdidasFiscalesService extends BaseCrudPrismaService<
  CreatePerdidaFiscalDto,
  UpdatePerdidaFiscalDto
> {
  protected get model() {
    return this.prisma.fiscal_losses;
  }
  protected readonly orderField = 'ejercicio';

  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /**
   * Obtiene todas las pérdidas fiscales activas con cálculo de estado
   */
  async findAll(): Promise<FiscalLossRow[]> {
    const data = await this.prisma.fiscal_losses.findMany({
      where: { is_active: true },
      orderBy: { ejercicio: 'desc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data as any as FiscalLossRow[]).map((d) => this.enrichWithStatus(d));
  }

  /**
   * Obtiene una pérdida fiscal por ID
   */
  async findOne(id: string): Promise<FiscalLossRow> {
    const data = await this.prisma.fiscal_losses.findFirst({
      where: { id, is_active: true },
    });

    if (!data) throw new NotFoundException('Pérdida fiscal no encontrada');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.enrichWithStatus(data as any as FiscalLossRow);
  }

  /**
   * Crea una nueva pérdida fiscal
   * Calcula automáticamente la fecha de vencimiento (10 años)
   */
  async create(dto: CreatePerdidaFiscalDto, userId?: string): Promise<FiscalLossRow> {
    // Calcular fecha de vencimiento (10 años desde fecha de declaración)
    const fechaDeclaracion = new Date(dto.fecha_declaracion);
    const fechaVencimiento = new Date(fechaDeclaracion);
    fechaVencimiento.setFullYear(fechaVencimiento.getFullYear() + 10);

    // Factor de actualización por defecto es 1 (sin actualización)
    const factor = dto.factor_actualizacion ?? 1;
    const montoActualizado = dto.monto_original * factor;

    const insertData = {
      ejercicio: dto.ejercicio,
      fecha_declaracion: new Date(dto.fecha_declaracion),
      fecha_vencimiento: new Date(fechaVencimiento.toISOString().split('T')[0]),
      monto_original: dto.monto_original,
      monto_actualizado: montoActualizado,
      amortizado: 0,
      saldo_pendiente: montoActualizado,
      factor_actualizacion: factor,
      status: 'vigente',
      notes: dto.notes || null,
      created_by: userId || null,
    };

    const data = await this.prisma.fiscal_losses.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: insertData as any,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.enrichWithStatus(data as any as FiscalLossRow);
  }

  /**
   * Actualiza una pérdida fiscal
   * Recalcula montos si se cambia el factor de actualización
   */
  async update(id: string, dto: UpdatePerdidaFiscalDto): Promise<FiscalLossRow> {
    const existing = await this.findOne(id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateData: any = { ...dto };

    // Si se actualiza el factor, recalcular montos
    if (dto.factor_actualizacion !== undefined || dto.monto_original !== undefined) {
      const montoOriginal = Number(dto.monto_original ?? existing.monto_original);
      const factor = Number(dto.factor_actualizacion ?? existing.factor_actualizacion);
      const montoActualizado = montoOriginal * factor;

      updateData.monto_original = montoOriginal;
      updateData.factor_actualizacion = factor;
      updateData.monto_actualizado = montoActualizado;
      updateData.saldo_pendiente = montoActualizado - Number(existing.amortizado);
    }

    // Si se actualiza la fecha de declaración, recalcular vencimiento
    if (dto.fecha_declaracion) {
      const fechaDeclaracion = new Date(dto.fecha_declaracion);
      const fechaVencimiento = new Date(fechaDeclaracion);
      fechaVencimiento.setFullYear(fechaVencimiento.getFullYear() + 10);
      updateData.fecha_declaracion = fechaDeclaracion;
      updateData.fecha_vencimiento = new Date(fechaVencimiento.toISOString().split('T')[0]);
    }

    let data;
    try {
      data = await this.prisma.fiscal_losses.update({
        where: { id },
        data: updateData,
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Pérdida fiscal no encontrada');
      }
      throw err;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.enrichWithStatus(data as any as FiscalLossRow);
  }

  /**
   * Registra una amortización de pérdida fiscal
   */
  async amortizar(
    dto: CreateAmortizacionDto,
    userId: string,
  ): Promise<{ loss: FiscalLossRow; amortization: AmortizationRow }> {
    const loss = await this.findOne(dto.fiscal_loss_id);

    // Validar que hay suficiente saldo pendiente
    if (dto.monto_amortizado > Number(loss.saldo_pendiente)) {
      throw new BadRequestException(
        `El monto a amortizar ($${dto.monto_amortizado.toLocaleString()}) excede el saldo pendiente ($${Number(loss.saldo_pendiente).toLocaleString()})`,
      );
    }

    // Validar que no esté vencida
    if (loss.status === 'vencida') {
      throw new BadRequestException('No se puede amortizar una pérdida fiscal vencida');
    }

    // Validar que no esté agotada
    if (loss.status === 'amortizada_total') {
      throw new BadRequestException('Esta pérdida fiscal ya fue completamente amortizada');
    }

    // Crear amortización
    const amortizationData = {
      fiscal_loss_id: dto.fiscal_loss_id,
      ejercicio_aplicacion: dto.ejercicio_aplicacion,
      monto_amortizado: dto.monto_amortizado,
      notes: dto.notes || null,
      created_by: userId,
    };

    const amortization = await this.prisma.fiscal_loss_amortizations.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: amortizationData as any,
    });

    // Actualizar pérdida fiscal
    const nuevoAmortizado = Number(loss.amortizado) + dto.monto_amortizado;
    const nuevoSaldoPendiente = Number(loss.monto_actualizado) - nuevoAmortizado;
    const nuevoStatus = nuevoSaldoPendiente <= 0 ? 'amortizada_total' : 'vigente';

    const updatedLoss = await this.prisma.fiscal_losses.update({
      where: { id: dto.fiscal_loss_id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: {
        amortizado: nuevoAmortizado,
        saldo_pendiente: nuevoSaldoPendiente,
        status: nuevoStatus,
      } as any,
    });

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      loss: this.enrichWithStatus(updatedLoss as any as FiscalLossRow),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      amortization: amortization as any as AmortizationRow,
    };
  }

  /**
   * Obtiene el historial de amortizaciones de una pérdida fiscal
   */
  async getAmortizaciones(fiscalLossId: string): Promise<AmortizationRow[]> {
    const data = await this.prisma.fiscal_loss_amortizations.findMany({
      where: { fiscal_loss_id: fiscalLossId, is_active: true },
      include: { profiles: { select: { id: true, full_name: true } } },
      orderBy: { ejercicio_aplicacion: 'desc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return data as any as AmortizationRow[];
  }

  /**
   * Obtiene alertas de pérdidas fiscales próximas a vencer
   */
  async getAlertas(): Promise<{ proximas_vencer: FiscalLossRow[]; vencidas: FiscalLossRow[] }> {
    const today = new Date();
    const sixMonthsFromNow = new Date();
    sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);

    const data = await this.prisma.fiscal_losses.findMany({
      where: {
        is_active: true,
        status: { not: 'amortizada_total' },
        fecha_vencimiento: { lte: sixMonthsFromNow },
      },
      orderBy: { fecha_vencimiento: 'asc' },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const losses = (data as any as FiscalLossRow[]).map((d) => this.enrichWithStatus(d));
    const todayStr = today.toISOString().split('T')[0];

    return {
      proximas_vencer: losses.filter((l) => {
        const fv = new Date(l.fecha_vencimiento).toISOString().split('T')[0];
        return fv > todayStr && l.status === 'proxima_a_vencer';
      }),
      vencidas: losses.filter((l) => {
        const fv = new Date(l.fecha_vencimiento).toISOString().split('T')[0];
        return fv <= todayStr || l.status === 'vencida';
      }),
    };
  }

  /**
   * Actualiza el factor INPC de una pérdida fiscal
   */
  async actualizarFactorINPC(id: string, nuevoFactor: number): Promise<FiscalLossRow> {
    const loss = await this.findOne(id);

    const montoActualizado = Number(loss.monto_original) * nuevoFactor;
    const saldoPendiente = montoActualizado - Number(loss.amortizado);

    let data;
    try {
      data = await this.prisma.fiscal_losses.update({
        where: { id },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: {
          factor_actualizacion: nuevoFactor,
          monto_actualizado: montoActualizado,
          saldo_pendiente: saldoPendiente,
        } as any,
      });
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2025') {
        throw new NotFoundException('Pérdida fiscal no encontrada');
      }
      throw err;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.enrichWithStatus(data as any as FiscalLossRow);
  }

  /**
   * Enriquece una pérdida fiscal con estado calculado
   */
  private enrichWithStatus(loss: FiscalLossRow): FiscalLossRow {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const threeMonthsFromNow = new Date();
    threeMonthsFromNow.setMonth(threeMonthsFromNow.getMonth() + 3);
    const threeMonthsStr = threeMonthsFromNow.toISOString().split('T')[0];

    // Si ya está completamente amortizada, mantener ese estado
    if (loss.status === 'amortizada_total' || Number(loss.saldo_pendiente) <= 0) {
      return { ...loss, status: 'amortizada_total' };
    }

    const fechaVencimientoStr = new Date(loss.fecha_vencimiento).toISOString().split('T')[0];

    // Verificar si está vencida
    if (fechaVencimientoStr <= todayStr) {
      return { ...loss, status: 'vencida' };
    }

    // Verificar si está próxima a vencer (3 meses)
    if (fechaVencimientoStr <= threeMonthsStr) {
      return { ...loss, status: 'proxima_a_vencer' };
    }

    // Si no ha vencido ni está próxima, está vigente
    return { ...loss, status: 'vigente' };
  }
}

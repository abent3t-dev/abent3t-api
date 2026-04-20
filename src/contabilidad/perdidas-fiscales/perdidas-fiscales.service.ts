import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { BaseCrudService } from '../../common/services/base-crud.service';
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
export class PerdidasFiscalesService extends BaseCrudService<CreatePerdidaFiscalDto, UpdatePerdidaFiscalDto> {
  protected readonly tableName = 'fiscal_losses';
  protected readonly selectFields = '*';
  protected readonly orderField = 'ejercicio';

  constructor(supabase: SupabaseService) {
    super(supabase);
  }

  /**
   * Obtiene todas las pérdidas fiscales activas con cálculo de estado
   */
  async findAll(): Promise<FiscalLossRow[]> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('is_active', true)
      .order('ejercicio', { ascending: false });

    if (error) throw error;
    return (data as FiscalLossRow[]).map(this.enrichWithStatus);
  }

  /**
   * Obtiene una pérdida fiscal por ID
   */
  async findOne(id: string): Promise<FiscalLossRow> {
    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('id', id)
      .eq('is_active', true)
      .single();

    if (error || !data) throw new NotFoundException('Pérdida fiscal no encontrada');
    return this.enrichWithStatus(data as FiscalLossRow);
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
      fecha_declaracion: dto.fecha_declaracion,
      fecha_vencimiento: fechaVencimiento.toISOString().split('T')[0],
      monto_original: dto.monto_original,
      monto_actualizado: montoActualizado,
      amortizado: 0,
      saldo_pendiente: montoActualizado,
      factor_actualizacion: factor,
      status: 'vigente',
      notes: dto.notes || null,
      created_by: userId || null,
    };

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .insert(insertData as any)
      .select(this.selectFields)
      .single();

    if (error) throw error;
    return this.enrichWithStatus(data as FiscalLossRow);
  }

  /**
   * Actualiza una pérdida fiscal
   * Recalcula montos si se cambia el factor de actualización
   */
  async update(id: string, dto: UpdatePerdidaFiscalDto): Promise<FiscalLossRow> {
    const existing = await this.findOne(id);

    const updateData: any = { ...dto };

    // Si se actualiza el factor, recalcular montos
    if (dto.factor_actualizacion !== undefined || dto.monto_original !== undefined) {
      const montoOriginal = dto.monto_original ?? existing.monto_original;
      const factor = dto.factor_actualizacion ?? existing.factor_actualizacion;
      const montoActualizado = montoOriginal * factor;

      updateData.monto_original = montoOriginal;
      updateData.factor_actualizacion = factor;
      updateData.monto_actualizado = montoActualizado;
      updateData.saldo_pendiente = montoActualizado - existing.amortizado;
    }

    // Si se actualiza la fecha de declaración, recalcular vencimiento
    if (dto.fecha_declaracion) {
      const fechaDeclaracion = new Date(dto.fecha_declaracion);
      const fechaVencimiento = new Date(fechaDeclaracion);
      fechaVencimiento.setFullYear(fechaVencimiento.getFullYear() + 10);
      updateData.fecha_vencimiento = fechaVencimiento.toISOString().split('T')[0];
    }

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update(updateData)
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error || !data) throw new NotFoundException('Pérdida fiscal no encontrada');
    return this.enrichWithStatus(data as FiscalLossRow);
  }

  /**
   * Registra una amortización de pérdida fiscal
   */
  async amortizar(dto: CreateAmortizacionDto, userId: string): Promise<{ loss: FiscalLossRow; amortization: AmortizationRow }> {
    const loss = await this.findOne(dto.fiscal_loss_id);

    // Validar que hay suficiente saldo pendiente
    if (dto.monto_amortizado > loss.saldo_pendiente) {
      throw new BadRequestException(
        `El monto a amortizar ($${dto.monto_amortizado.toLocaleString()}) excede el saldo pendiente ($${loss.saldo_pendiente.toLocaleString()})`,
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

    const { data: amortization, error: amortError } = await this.supabase.db
      .from('fiscal_loss_amortizations')
      .insert(amortizationData as any)
      .select('*')
      .single();

    if (amortError) throw amortError;

    // Actualizar pérdida fiscal
    const nuevoAmortizado = loss.amortizado + dto.monto_amortizado;
    const nuevoSaldoPendiente = loss.monto_actualizado - nuevoAmortizado;
    const nuevoStatus = nuevoSaldoPendiente <= 0 ? 'amortizada_total' : 'vigente';

    const { data: updatedLoss, error: updateError } = await this.supabase.db
      .from(this.tableName)
      .update({
        amortizado: nuevoAmortizado,
        saldo_pendiente: nuevoSaldoPendiente,
        status: nuevoStatus,
      } as any)
      .eq('id', dto.fiscal_loss_id)
      .select(this.selectFields)
      .single();

    if (updateError) throw updateError;

    return {
      loss: this.enrichWithStatus(updatedLoss as FiscalLossRow),
      amortization: amortization as AmortizationRow,
    };
  }

  /**
   * Obtiene el historial de amortizaciones de una pérdida fiscal
   */
  async getAmortizaciones(fiscalLossId: string): Promise<AmortizationRow[]> {
    const { data, error } = await this.supabase.db
      .from('fiscal_loss_amortizations')
      .select('*, profiles:created_by(id, full_name)')
      .eq('fiscal_loss_id', fiscalLossId)
      .eq('is_active', true)
      .order('ejercicio_aplicacion', { ascending: false });

    if (error) throw error;
    return data as AmortizationRow[];
  }

  /**
   * Obtiene alertas de pérdidas fiscales próximas a vencer
   */
  async getAlertas(): Promise<{ proximas_vencer: FiscalLossRow[]; vencidas: FiscalLossRow[] }> {
    const today = new Date();
    const sixMonthsFromNow = new Date();
    sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .select(this.selectFields)
      .eq('is_active', true)
      .neq('status', 'amortizada_total')
      .lte('fecha_vencimiento', sixMonthsFromNow.toISOString().split('T')[0])
      .order('fecha_vencimiento', { ascending: true });

    if (error) throw error;

    const losses = (data as FiscalLossRow[]).map(this.enrichWithStatus);
    const todayStr = today.toISOString().split('T')[0];

    return {
      proximas_vencer: losses.filter((l) => l.fecha_vencimiento > todayStr && l.status === 'proxima_a_vencer'),
      vencidas: losses.filter((l) => l.fecha_vencimiento <= todayStr || l.status === 'vencida'),
    };
  }

  /**
   * Actualiza el factor INPC de una pérdida fiscal
   */
  async actualizarFactorINPC(id: string, nuevoFactor: number): Promise<FiscalLossRow> {
    const loss = await this.findOne(id);

    const montoActualizado = loss.monto_original * nuevoFactor;
    const saldoPendiente = montoActualizado - loss.amortizado;

    const { data, error } = await this.supabase.db
      .from(this.tableName)
      .update({
        factor_actualizacion: nuevoFactor,
        monto_actualizado: montoActualizado,
        saldo_pendiente: saldoPendiente,
      } as any)
      .eq('id', id)
      .select(this.selectFields)
      .single();

    if (error || !data) throw new NotFoundException('Pérdida fiscal no encontrada');
    return this.enrichWithStatus(data as FiscalLossRow);
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
    if (loss.status === 'amortizada_total' || loss.saldo_pendiente <= 0) {
      return { ...loss, status: 'amortizada_total' };
    }

    // Verificar si está vencida
    if (loss.fecha_vencimiento <= todayStr) {
      return { ...loss, status: 'vencida' };
    }

    // Verificar si está próxima a vencer (3 meses)
    if (loss.fecha_vencimiento <= threeMonthsStr) {
      return { ...loss, status: 'proxima_a_vencer' };
    }

    // Si no ha vencido ni está próxima, está vigente
    return { ...loss, status: 'vigente' };
  }
}

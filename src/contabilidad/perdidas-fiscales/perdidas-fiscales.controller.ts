import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PerdidasFiscalesService, FiscalLossRow, AmortizationRow } from './perdidas-fiscales.service';
import { CreatePerdidaFiscalDto } from './dto/create-perdida-fiscal.dto';
import { UpdatePerdidaFiscalDto } from './dto/update-perdida-fiscal.dto';
import { CreateAmortizacionDto } from './dto/create-amortizacion.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { PaginatedResponse } from '../../common/interfaces/paginated-response.interface';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../../audit/audit.service';

@Controller('contabilidad/fiscal/perdidas')
export class PerdidasFiscalesController {
  constructor(
    private readonly service: PerdidasFiscalesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lista todas las pérdidas fiscales
   * Roles: contabilidad, fiscal, director_financiero (solo lectura)
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get()
  findAll(@Query() pagination: PaginationDto): Promise<FiscalLossRow[] | PaginatedResponse<FiscalLossRow>> {
    if (pagination.page || pagination.limit || pagination.search) {
      return this.service.findAllPaginated(pagination);
    }
    return this.service.findAll();
  }

  /**
   * Obtiene alertas de pérdidas próximas a vencer
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get('alertas')
  getAlertas(): Promise<{ proximas_vencer: FiscalLossRow[]; vencidas: FiscalLossRow[] }> {
    return this.service.getAlertas();
  }

  /**
   * Obtiene una pérdida fiscal por ID
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<FiscalLossRow> {
    return this.service.findOne(id);
  }

  /**
   * Obtiene las amortizaciones de una pérdida fiscal
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get(':id/amortizaciones')
  getAmortizaciones(@Param('id', ParseUUIDPipe) id: string): Promise<AmortizationRow[]> {
    return this.service.getAmortizaciones(id);
  }

  /**
   * Crea una nueva pérdida fiscal
   */
  @Roles('contabilidad', 'fiscal')
  @Post()
  async create(@Body() dto: CreatePerdidaFiscalDto, @CurrentUser() user: AuthUser): Promise<FiscalLossRow> {
    const result = await this.service.create(dto, user.id);
    await this.audit.log({
      action: 'create',
      entity_type: 'fiscal_loss',
      entity_id: result.id,
      entity_name: `Pérdida fiscal ${result.ejercicio}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        ejercicio: result.ejercicio,
        monto_original: result.monto_original,
        fecha_declaracion: result.fecha_declaracion,
      },
    });
    return result;
  }

  /**
   * Actualiza una pérdida fiscal
   */
  @Roles('contabilidad', 'fiscal')
  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePerdidaFiscalDto,
    @CurrentUser() user: AuthUser,
  ): Promise<FiscalLossRow> {
    const oldLoss = await this.service.findOne(id);
    const result = await this.service.update(id, dto);
    await this.audit.log({
      action: 'update',
      entity_type: 'fiscal_loss',
      entity_id: id,
      entity_name: `Pérdida fiscal ${result.ejercicio}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      old_values: {
        monto_original: oldLoss.monto_original,
        factor_actualizacion: oldLoss.factor_actualizacion,
      },
      new_values: dto,
    });
    return result;
  }

  /**
   * Registra una amortización
   */
  @Roles('contabilidad', 'fiscal')
  @Post(':id/amortizar')
  async amortizar(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAmortizacionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<{ loss: FiscalLossRow; amortization: AmortizationRow }> {
    // Asegurar que el ID del path coincide con el del DTO
    dto.fiscal_loss_id = id;
    const result = await this.service.amortizar(dto, user.id);
    await this.audit.log({
      action: 'update',
      entity_type: 'fiscal_loss',
      entity_id: id,
      entity_name: `Amortización - Pérdida fiscal ${result.loss.ejercicio}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        ejercicio_aplicacion: dto.ejercicio_aplicacion,
        monto_amortizado: dto.monto_amortizado,
        nuevo_saldo_pendiente: result.loss.saldo_pendiente,
      },
    });
    return result;
  }

  /**
   * Actualiza el factor INPC de una pérdida fiscal
   */
  @Roles('contabilidad', 'fiscal')
  @Put(':id/factor-inpc')
  async actualizarFactorINPC(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { factor: number },
    @CurrentUser() user: AuthUser,
  ): Promise<FiscalLossRow> {
    const oldLoss = await this.service.findOne(id);
    const result = await this.service.actualizarFactorINPC(id, body.factor);
    await this.audit.log({
      action: 'update',
      entity_type: 'fiscal_loss',
      entity_id: id,
      entity_name: `Factor INPC - Pérdida fiscal ${result.ejercicio}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      old_values: {
        factor_actualizacion: oldLoss.factor_actualizacion,
        monto_actualizado: oldLoss.monto_actualizado,
      },
      new_values: {
        factor_actualizacion: result.factor_actualizacion,
        monto_actualizado: result.monto_actualizado,
      },
    });
    return result;
  }

  /**
   * Desactiva una pérdida fiscal (soft delete)
   */
  @Roles('contabilidad', 'fiscal')
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const loss = await this.service.findOne(id);
    const result = await this.service.remove(id);
    await this.audit.log({
      action: 'delete',
      entity_type: 'fiscal_loss',
      entity_id: id,
      entity_name: `Pérdida fiscal ${loss.ejercicio}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
    });
    return result;
  }
}

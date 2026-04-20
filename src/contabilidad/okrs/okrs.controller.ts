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
import { OkrsService, OkrRow, OkrStats } from './okrs.service';
import { CreateOkrDto } from './dto/create-okr.dto';
import { UpdateOkrDto } from './dto/update-okr.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { PaginatedResponse } from '../../common/interfaces/paginated-response.interface';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../../audit/audit.service';

@Controller('contabilidad/okrs')
export class OkrsController {
  constructor(
    private readonly service: OkrsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lista todos los OKRs o filtra por período
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get()
  findAll(@Query('periodo') periodo?: string, @Query() pagination?: PaginationDto): Promise<OkrRow[] | PaginatedResponse<OkrRow>> {
    if (periodo) {
      return this.service.findByPeriodo(periodo);
    }
    if (pagination?.page || pagination?.limit) {
      return this.service.findAllPaginated(pagination);
    }
    return this.service.findAll();
  }

  /**
   * Obtiene estadísticas de OKRs
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get('stats')
  getStats(@Query('periodo') periodo?: string): Promise<OkrStats> {
    return this.service.getStats(periodo);
  }

  /**
   * Obtiene lista de períodos disponibles
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get('periodos')
  getPeriodos() {
    return this.service.getPeriodos();
  }

  /**
   * Obtiene un OKR por ID
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<OkrRow> {
    return this.service.findOne(id);
  }

  /**
   * Crea un nuevo OKR
   */
  @Roles('contabilidad', 'fiscal')
  @Post()
  async create(@Body() dto: CreateOkrDto, @CurrentUser() user: AuthUser): Promise<OkrRow> {
    const result = await this.service.create(dto, user.id);
    await this.audit.log({
      action: 'create',
      entity_type: 'okr',
      entity_id: result.id,
      entity_name: `${result.tipo === 'objective' ? 'Objetivo' : 'KR'}: ${result.titulo}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        tipo: result.tipo,
        titulo: result.titulo,
        periodo: result.periodo,
      },
    });
    return result;
  }

  /**
   * Actualiza un OKR
   */
  @Roles('contabilidad', 'fiscal')
  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOkrDto,
    @CurrentUser() user: AuthUser,
  ): Promise<OkrRow> {
    const oldOkr = await this.service.findOne(id);
    const result = await this.service.update(id, dto);
    await this.audit.log({
      action: 'update',
      entity_type: 'okr',
      entity_id: id,
      entity_name: `${result.tipo === 'objective' ? 'Objetivo' : 'KR'}: ${result.titulo}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      old_values: {
        status: oldOkr.status,
        current_value: oldOkr.current_value,
      },
      new_values: dto,
    });
    return result;
  }

  /**
   * Actualiza solo el progreso de un OKR (endpoint simplificado)
   */
  @Roles('contabilidad', 'fiscal')
  @Put(':id/progress')
  async updateProgress(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { current_value: number },
    @CurrentUser() user: AuthUser,
  ): Promise<OkrRow> {
    const oldOkr = await this.service.findOne(id);
    const result = await this.service.update(id, { current_value: body.current_value });
    await this.audit.log({
      action: 'update',
      entity_type: 'okr',
      entity_id: id,
      entity_name: `Progreso - ${result.titulo}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      old_values: {
        current_value: oldOkr.current_value,
        status: oldOkr.status,
      },
      new_values: {
        current_value: body.current_value,
        status: result.status,
      },
    });
    return result;
  }

  /**
   * Desactiva un OKR (soft delete)
   */
  @Roles('contabilidad', 'fiscal')
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const okr = await this.service.findOne(id);
    const result = await this.service.remove(id);
    await this.audit.log({
      action: 'delete',
      entity_type: 'okr',
      entity_id: id,
      entity_name: `${okr.tipo === 'objective' ? 'Objetivo' : 'KR'}: ${okr.titulo}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
    });
    return result;
  }
}

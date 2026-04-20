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
import { NoDeduciblesService, NoDeducibleRow, DepartmentStats, PeriodTrend } from './no-deducibles.service';
import { CreateNoDeducibleDto } from './dto/create-no-deducible.dto';
import { UpdateNoDeducibleDto } from './dto/update-no-deducible.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { PaginatedResponse } from '../../common/interfaces/paginated-response.interface';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../../audit/audit.service';

@Controller('contabilidad/fiscal/no-deducibles')
export class NoDeduciblesController {
  constructor(
    private readonly service: NoDeduciblesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lista todos los no deducibles
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get()
  findAll(@Query() pagination: PaginationDto): Promise<NoDeducibleRow[] | PaginatedResponse<NoDeducibleRow>> {
    if (pagination.page || pagination.limit || pagination.search) {
      return this.service.findAllPaginated(pagination);
    }
    return this.service.findAll();
  }

  /**
   * Obtiene estadísticas generales
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get('stats')
  getStats(@Query('periodo') periodo?: string): Promise<{
    total: number;
    count: number;
    by_department: DepartmentStats[];
    trend: PeriodTrend[];
    top_conceptos: { concepto: string; total: number }[];
  }> {
    return this.service.getStats(periodo);
  }

  /**
   * Obtiene no deducibles por departamento
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get('department/:departmentId')
  findByDepartment(@Param('departmentId', ParseUUIDPipe) departmentId: string): Promise<NoDeducibleRow[]> {
    return this.service.findByDepartment(departmentId);
  }

  /**
   * Obtiene no deducibles por período
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get('periodo/:periodo')
  findByPeriodo(@Param('periodo') periodo: string): Promise<NoDeducibleRow[]> {
    return this.service.findByPeriodo(periodo);
  }

  /**
   * Obtiene un no deducible por ID
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  /**
   * Crea un nuevo no deducible
   */
  @Roles('contabilidad', 'fiscal')
  @Post()
  async create(@Body() dto: CreateNoDeducibleDto, @CurrentUser() user: AuthUser): Promise<NoDeducibleRow> {
    const result = await this.service.create(dto, user.id);
    await this.audit.log({
      action: 'create',
      entity_type: 'non_deductible',
      entity_id: result.id,
      entity_name: `${result.concepto} - ${result.periodo}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        concepto: result.concepto,
        monto: result.monto,
        periodo: result.periodo,
        department: result.departments?.name,
      },
    });
    return result;
  }

  /**
   * Actualiza un no deducible
   */
  @Roles('contabilidad', 'fiscal')
  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNoDeducibleDto,
    @CurrentUser() user: AuthUser,
  ) {
    const oldItem = await this.service.findOne(id);
    const result = await this.service.update(id, dto);
    await this.audit.log({
      action: 'update',
      entity_type: 'non_deductible',
      entity_id: id,
      entity_name: `${result.concepto} - ${result.periodo}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      old_values: {
        concepto: oldItem.concepto,
        monto: oldItem.monto,
      },
      new_values: dto,
    });
    return result;
  }

  /**
   * Desactiva un no deducible (soft delete)
   */
  @Roles('contabilidad', 'fiscal')
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const item = await this.service.findOne(id);
    const result = await this.service.remove(id);
    await this.audit.log({
      action: 'delete',
      entity_type: 'non_deductible',
      entity_id: id,
      entity_name: `${item.concepto} - ${item.periodo}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
    });
    return result;
  }
}

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
  UseInterceptors,
  UploadedFile,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { BudgetsService, ImportResult } from './budgets.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';

@Controller('budgets')
export class BudgetsController {
  constructor(
    private readonly service: BudgetsService,
    private readonly audit: AuditService,
  ) {}

  @Roles('admin_rh')
  @Get()
  findAll(@Query() pagination: PaginationDto) {
    if (pagination.page || pagination.limit || pagination.search) {
      return this.service.findAllPaginated(pagination);
    }
    return this.service.findAll();
  }

  @Roles('admin_rh')
  @Get('export-template')
  async exportTemplate(
    @Query('include_data') includeData?: string,
    @Res() res?: Response,
  ): Promise<void> {
    const shouldIncludeData = includeData === 'true';
    const buffer = await this.service.exportTemplate(shouldIncludeData);

    const filename = shouldIncludeData
      ? 'presupuestos_con_datos.xlsx'
      : 'plantilla_presupuestos.xlsx';

    if (!res) {
      throw new Error('Response object not available');
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Roles('admin_rh')
  @Get('department/:departmentId')
  findByDepartment(@Param('departmentId', ParseUUIDPipe) departmentId: string) {
    return this.service.findByDepartment(departmentId);
  }

  @Roles('admin_rh')
  @Get('period/:periodId')
  findByPeriod(@Param('periodId', ParseUUIDPipe) periodId: string) {
    return this.service.findByPeriod(periodId);
  }

  @Roles('admin_rh')
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Roles('admin_rh')
  @Post()
  async create(@Body() dto: CreateBudgetDto, @CurrentUser() user: AuthUser) {
    const result = await this.service.create(dto);
    await this.audit.log({
      action: 'create',
      entity_type: 'budget',
      entity_id: result.id,
      entity_name: `${result.departments?.name || 'Área'} - ${result.periods?.label || 'Período'}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: { assigned_amount: dto.assigned_amount },
    });
    return result;
  }

  @Roles('admin_rh')
  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBudgetDto,
    @CurrentUser() user: AuthUser,
  ) {
    const oldBudget = await this.service.findOne(id);
    const result = await this.service.update(id, dto);
    await this.audit.log({
      action: 'update',
      entity_type: 'budget',
      entity_id: id,
      entity_name: `${result.departments?.name || 'Área'} - ${result.periods?.label || 'Período'}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      old_values: { assigned_amount: oldBudget.assigned_amount },
      new_values: dto,
    });
    return result;
  }

  @Roles('admin_rh')
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const budget = await this.service.findOne(id);
    const result = await this.service.remove(id);
    await this.audit.log({
      action: 'delete',
      entity_type: 'budget',
      entity_id: id,
      entity_name: `${budget.departments?.name || 'Área'} - ${budget.periods?.label || 'Período'}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
    });
    return result;
  }

  @Roles('admin_rh')
  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  async importBudgets(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthUser,
  ): Promise<ImportResult> {
    if (!file) {
      throw new Error('No se proporcionó ningún archivo');
    }

    // Validar extensión
    const allowedExtensions = ['.xlsx', '.xls'];
    const fileExtension = file.originalname.toLowerCase().substring(file.originalname.lastIndexOf('.'));

    if (!allowedExtensions.includes(fileExtension)) {
      throw new Error('Formato de archivo inválido. Solo se permiten archivos .xlsx o .xls');
    }

    // Validar tamaño (5MB max)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      throw new Error('El archivo es demasiado grande. Tamaño máximo: 5MB');
    }

    const result = await this.service.importBudgets(file.buffer);

    // Log de auditoría
    await this.audit.log({
      action: 'create',
      entity_type: 'budget',
      entity_id: '00000000-0000-0000-0000-000000000000', // UUID especial para operaciones masivas
      entity_name: `Importación masiva: ${result.success} exitosos, ${result.errors.length} errores`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: result,
    });

    return result;
  }
}

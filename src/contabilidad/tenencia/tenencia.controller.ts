import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { TenenciaService, ShareholdingRecord } from './tenencia.service';
import { CreateTenenciaDto } from './dto/create-tenencia.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../../audit/audit.service';

@Controller('contabilidad/tenencia')
export class TenenciaController {
  constructor(
    private readonly service: TenenciaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Obtiene la tenencia accionaria vigente
   * Roles: contabilidad, fiscal, director_financiero, accionista
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero', 'accionista')
  @Get()
  getCurrent(): Promise<ShareholdingRecord | null> {
    return this.service.getCurrent();
  }

  /**
   * Obtiene el historial de versiones de tenencia
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get('historial')
  getHistorial(): Promise<ShareholdingRecord[]> {
    return this.service.getHistorial();
  }

  /**
   * Compara dos versiones de tenencia
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero')
  @Get('comparar')
  compareVersions(
    @Query('version1', ParseUUIDPipe) version1: string,
    @Query('version2', ParseUUIDPipe) version2: string,
  ): Promise<{
    version1: ShareholdingRecord;
    version2: ShareholdingRecord;
    changes: {
      added: string[];
      removed: string[];
      changed: { nombre: string; from: number; to: number }[];
    };
  }> {
    return this.service.compareVersions(version1, version2);
  }

  /**
   * Obtiene una versión específica de tenencia
   */
  @Roles('contabilidad', 'fiscal', 'director_financiero', 'accionista')
  @Get(':id')
  getVersion(@Param('id', ParseUUIDPipe) id: string): Promise<ShareholdingRecord> {
    return this.service.getVersion(id);
  }

  /**
   * Crea una nueva versión de tenencia
   */
  @Roles('contabilidad', 'fiscal')
  @Post()
  async create(@Body() dto: CreateTenenciaDto, @CurrentUser() user: AuthUser): Promise<ShareholdingRecord> {
    const result = await this.service.create(dto, user.id);
    await this.audit.log({
      action: 'create',
      entity_type: 'shareholding',
      entity_id: result.id,
      entity_name: `Tenencia v${result.version} - ${result.effective_date}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
      new_values: {
        version: result.version,
        effective_date: result.effective_date,
        accionistas: result.shareholding_detail?.length || 0,
      },
    });
    return result;
  }

  /**
   * Elimina una versión de tenencia (soft delete)
   */
  @Roles('contabilidad', 'fiscal')
  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser): Promise<{ message: string }> {
    const record = await this.service.getVersion(id);
    const result = await this.service.remove(id);
    await this.audit.log({
      action: 'delete',
      entity_type: 'shareholding',
      entity_id: id,
      entity_name: `Tenencia v${record.version} - ${record.effective_date}`,
      user_id: user.id,
      user_name: user.full_name,
      user_role: user.role,
    });
    return result;
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  CreateErpAliasDto,
  ErpAliasQueryDto,
  ImportErpAliasDto,
  UpdateErpAliasDto,
} from './dto/erp-alias.dto';
import { ErpAliasesService } from './erp-aliases.service';

// Gestión de equivalencias: mismo alcance que el apartado de roles de
// Compras (super_admin bypassa RolesGuard). La lectura también queda
// restringida: es configuración, no consulta de negocio.
const PURCHASE_ROLE_MANAGERS = ['super_admin', 'lider_procura'];

/** Bloque 2026-09-23 (D6) — usuarios de SAP y Maximo → nombre / perfil. */
@Controller('compras/erp-aliases')
export class ErpAliasesController {
  constructor(private readonly service: ErpAliasesService) {}

  @Roles(...PURCHASE_ROLE_MANAGERS)
  @Get()
  list(@Query() query: ErpAliasQueryDto) {
    return this.service.list(query);
  }

  @Roles(...PURCHASE_ROLE_MANAGERS)
  @Post()
  create(@Body() dto: CreateErpAliasDto, @CurrentUser() user: { id: string }) {
    return this.service.create(dto, user.id);
  }

  @Roles(...PURCHASE_ROLE_MANAGERS)
  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  importFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: ImportErpAliasDto,
    @CurrentUser() user: { id: string },
  ) {
    return this.service.importFile(file, dto.system, user.id);
  }

  @Roles(...PURCHASE_ROLE_MANAGERS)
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateErpAliasDto,
  ) {
    return this.service.update(id, dto);
  }

  @Roles(...PURCHASE_ROLE_MANAGERS)
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}

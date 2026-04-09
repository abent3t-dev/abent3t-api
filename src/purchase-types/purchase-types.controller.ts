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
import { PurchaseTypesService } from './purchase-types.service';
import { CreatePurchaseTypeDto } from './dto/create-purchase-type.dto';
import { UpdatePurchaseTypeDto } from './dto/update-purchase-type.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('purchase-types')
export class PurchaseTypesController {
  constructor(private readonly service: PurchaseTypesService) {}

  @Get()
  findAll(@Query() pagination: PaginationDto) {
    if (pagination.page || pagination.limit || pagination.search) {
      return this.service.findAllPaginated(pagination);
    }
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
  }

  @Roles('admin_rh', 'coordinador_compras', 'lider_procura')
  @Post()
  create(@Body() dto: CreatePurchaseTypeDto) {
    return this.service.create(dto);
  }

  @Roles('admin_rh', 'coordinador_compras', 'lider_procura')
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseTypeDto,
  ) {
    return this.service.update(id, dto);
  }

  @Roles('admin_rh', 'coordinador_compras', 'lider_procura')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}

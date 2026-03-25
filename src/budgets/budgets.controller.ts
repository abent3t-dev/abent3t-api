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
import { BudgetsService } from './budgets.service';
import { CreateBudgetDto } from './dto/create-budget.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { Roles } from '../common/decorators/roles.decorator';

@Controller('budgets')
export class BudgetsController {
  constructor(private readonly service: BudgetsService) {}

  @Roles('admin_rh')
  @Get()
  findAll(@Query() pagination: PaginationDto) {
    if (pagination.page || pagination.limit || pagination.search) {
      return this.service.findAllPaginated(pagination);
    }
    return this.service.findAll();
  }

  @Roles('admin_rh')
  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findOne(id);
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
  @Post()
  create(@Body() dto: CreateBudgetDto) {
    return this.service.create(dto);
  }

  @Roles('admin_rh')
  @Put(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBudgetDto,
  ) {
    return this.service.update(id, dto);
  }

  @Roles('admin_rh')
  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(id);
  }
}

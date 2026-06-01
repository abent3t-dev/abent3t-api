import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { BusinessDaysService } from '../common/services/business-days.service';

/**
 * PrismaModule (@Global): expone PrismaService a toda la app y también
 * BusinessDaysService (que depende de Prisma). Aquí también irían otros
 * helpers transversales que requieran Prisma — mantenerlos en este módulo
 * evita ciclos de dependencias y elimina la necesidad de imports manuales.
 */
@Global()
@Module({
  providers: [PrismaService, BusinessDaysService],
  exports: [PrismaService, BusinessDaysService],
})
export class PrismaModule {}

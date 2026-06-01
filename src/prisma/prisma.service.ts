import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
  INestApplication,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'production'
          ? ['error', 'warn']
          : ['error', 'warn'],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma connected to abent3t_db');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  // Habilita shutdown hooks de Nest para que la conexión a la BD se cierre
  // limpiamente cuando el proceso recibe SIGTERM/SIGINT (importante en prod
  // con PM2/Docker).
  enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}

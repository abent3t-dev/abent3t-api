import { Module } from '@nestjs/common';
import { PurchaseUsersController } from './purchase-users.controller';
import { PurchaseUsersService } from './purchase-users.service';

/**
 * Fase §16 (T7) — Directorio de usuarios de compras (solo lectura, campos
 * mínimos). Módulo propio: no encaja en suppliers/purchase-types y NO toca
 * el módulo de auth.
 */
@Module({
  controllers: [PurchaseUsersController],
  providers: [PurchaseUsersService],
  exports: [PurchaseUsersService],
})
export class PurchaseUsersModule {}

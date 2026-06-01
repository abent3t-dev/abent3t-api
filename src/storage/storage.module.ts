import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * StorageModule (@Global): expone `StorageService` a toda la app —
 * consumido por `EvidencesService` y `ProposalsService` para los uploads,
 * URLs firmadas y soft-deletes.
 *
 * Reemplaza al uso directo de `supabase.db.storage` (Fase 3 del plan de
 * migración).
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}

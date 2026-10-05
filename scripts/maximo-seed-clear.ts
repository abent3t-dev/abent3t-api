/**
 * Fase INT-3 — T5: retira de staging las filas sembradas por
 * `maximo:seed-fixtures` (las que siguen apuntando a corridas
 * `triggered_by='seed'` en `last_sync_run_id`). Las corridas quedan en la
 * bitácora. Una fila sembrada que luego tocó una corrida real se conserva.
 * K3: el historial PRSTATUS (sin FK) se borra por prnum, solo de las PR que
 * ya no conservan ninguna fila.
 *
 * USO:  npm run maximo:seed-clear
 * SOLO desarrollo: aborta si NODE_ENV=production.
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { MaximoStagingService } from '../src/integrations/maximo/sync/maximo-staging.service';
import { MaximoSeedService } from '../src/integrations/maximo/sync/maximo-seed.service';

async function main(): Promise<void> {
  const prisma = new PrismaService();
  const seed = new MaximoSeedService(prisma, new MaximoStagingService(prisma));
  try {
    const result = await seed.clearSeeds();
    console.log(
      `Seed retirado: ${result.purchaseOrders} PO(s), ${result.contracts} contrato(s) y ${result.prStatusHistory} cambio(s) de historial de PR`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    'maximo:seed-clear falló:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});

/**
 * Fase INT-3 — T5: siembra los fixtures SANITIZADOS de Int-2 en staging
 * (`maximo_purchase_orders` / `maximo_contracts`) por el MISMO camino de
 * upsert del sync engine, con corridas `triggered_by='seed'`.
 *
 * USO:  npm run maximo:seed-fixtures
 *
 * - SOLO desarrollo: aborta si NODE_ENV=production (guard en el service).
 * - Idempotente: la segunda ejecución termina con 0 inserted / 0 updated.
 * - No toca la red ni requiere MAXIMO_* (solo DATABASE_URL, que PrismaClient
 *   lee de .env automáticamente).
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { MaximoStagingService } from '../src/integrations/maximo/sync/maximo-staging.service';
import { MaximoSeedService } from '../src/integrations/maximo/sync/maximo-seed.service';

async function main(): Promise<void> {
  const prisma = new PrismaService();
  const seed = new MaximoSeedService(prisma, new MaximoStagingService(prisma));
  try {
    const result = await seed.seedFixtures();
    console.log('Seed de fixtures Maximo completado:');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    'maximo:seed-fixtures falló:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});

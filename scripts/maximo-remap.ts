/**
 * Fase INT-3: re-mapea el staging de Maximo desde el `raw` JSONB con el mapper
 * ACTUAL (MAXIMO_MAPPER_VERSION), sin ninguna llamada a Maximo. Úsalo después
 * de cambiar reglas de mapeo (p. ej. cuando Isaac confirme
 * CONTRACTREFNUM/CONTRACTVALUE o la semántica de APPR1..APPR4).
 *
 * USO:  npm run maximo:remap            (ambos targets)
 *       npm run maximo:remap -- purchase_orders | contracts
 */
import { PrismaService } from '../src/prisma/prisma.service';
import { MaximoRemapService } from '../src/integrations/maximo/sync/maximo-remap.service';
import { MAXIMO_SYNC_TARGETS } from '../src/integrations/maximo/sync/maximo-sync.types';
import type { MaximoSyncTarget } from '../src/integrations/maximo/sync/maximo-sync.types';

async function main(): Promise<void> {
  const arg = process.argv[2];
  const targets: readonly MaximoSyncTarget[] =
    arg === undefined
      ? MAXIMO_SYNC_TARGETS
      : MAXIMO_SYNC_TARGETS.filter((t) => t === arg);
  if (targets.length === 0) {
    console.error(
      `Target inválido "${arg}". Usa: purchase_orders | contracts (o sin argumento para ambos).`,
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaService();
  const remap = new MaximoRemapService(prisma);
  try {
    for (const target of targets) {
      const result = await remap.remapAll(target);
      console.log(JSON.stringify(result, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    'maximo:remap falló:',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});

/**
 * Fase 0 — T2: migración de credenciales cifradas al esquema v2 (AES-256-GCM).
 *
 * Re-cifra `platform_integrations.private_key_encrypted` del formato legado
 * (aes-256-cbc sin prefijo) al formato `v2:`. Es la ÚNICA columna que el
 * código cifra hoy (sat_credentials.* y sap_connections.encrypted_password
 * existen en el schema pero ningún código las escribe — no hay datos que
 * migrar ahí).
 *
 * USO:
 *   npm run crypto:migrate
 *
 * Si los datos legados fueron cifrados con una clave DISTINTA a la actual
 * (p. ej. el fallback histórico del código, cuando PLATFORM_ENCRYPTION_KEY
 * no estaba definida), pásala por env var SOLO para esta corrida:
 *   CRYPTO_MIGRATE_LEGACY_KEY='<clave anterior>' npm run crypto:migrate
 *
 * - Idempotente: los registros ya `v2:` se saltan.
 * - No borra el soporte de lectura legada del CryptoService; eso se hará
 *   cuando esta migración haya corrido en todos los ambientes.
 * - Nunca imprime valores de credenciales ni claves.
 */
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from '../src/common/services/crypto.service';

async function main(): Promise<void> {
  const currentKey = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!currentKey) {
    console.error(
      'ERROR: PLATFORM_ENCRYPTION_KEY no está definida. Define la variable (o revisa .env) y reintenta.',
    );
    process.exit(1);
  }
  const legacyKey = process.env.CRYPTO_MIGRATE_LEGACY_KEY || currentKey;

  const cryptoService = new CryptoService({
    get: (name: string) => process.env[name],
  } as unknown as ConfigService);

  const prisma = new PrismaClient();
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const rows = await prisma.platform_integrations.findMany({
      where: { private_key_encrypted: { not: null } },
      select: { id: true, platform_type: true, private_key_encrypted: true },
    });

    console.log(`Registros con credencial cifrada: ${rows.length}`);

    for (const row of rows) {
      const ciphertext = row.private_key_encrypted as string;

      if (cryptoService.isV2(ciphertext)) {
        skipped++;
        continue;
      }

      try {
        // Descifrar legado: primero con la clave legada indicada; si difiere
        // de la actual y falla, intentar también con la actual.
        let plaintext: string;
        try {
          plaintext = cryptoService.decrypt(ciphertext, legacyKey);
        } catch (e) {
          if (legacyKey !== currentKey) {
            plaintext = cryptoService.decrypt(ciphertext, currentKey);
          } else {
            throw e;
          }
        }

        await prisma.platform_integrations.update({
          where: { id: row.id },
          data: { private_key_encrypted: cryptoService.encrypt(plaintext) },
        });
        migrated++;
      } catch {
        errors++;
        console.error(
          `  ERROR: no se pudo re-cifrar la integración ${row.id} (${row.platform_type}). ` +
            'Verifica CRYPTO_MIGRATE_LEGACY_KEY (clave con la que se cifró originalmente).',
        );
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log('--- Resultado de la migración ---');
  console.log(`  migrados: ${migrated}`);
  console.log(`  saltados (ya v2): ${skipped}`);
  console.log(`  errores: ${errors}`);
  process.exit(errors > 0 ? 1 : 0);
}

void main();

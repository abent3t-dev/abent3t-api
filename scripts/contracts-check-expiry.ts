/**
 * Fase §15: ejecuta manualmente el chequeo de vencimientos de contratos
 * (misma lógica que el cron de las 08:00 CDMX). Idempotente por diseño
 * (UNIQUE contract_id + tipo + destinatario): correrlo varias veces el mismo
 * día no re-envía nada. Sin credenciales AZURE_* los correos se SIMULAN
 * (quedan en el log), pero el registro de notificaciones sí se escribe.
 *
 * USO:  npm run contracts:check-expiry
 */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { EmailService } from '../src/email/email.service';
import { ContractExpiryService } from '../src/contracts/contract-expiry.service';

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const email = new EmailService(new ConfigService());
    const service = new ContractExpiryService(prisma, email);
    const result = await service.runCheck();
    console.log('Chequeo de vencimientos (§15):');
    console.log(`  contratos vigentes revisados: ${result.checkedContracts}`);
    console.log(`  notificaciones enviadas:      ${result.notificationsSent}`);
    console.log(`  ya notificadas (omitidas):    ${result.alreadyNotified}`);
    console.log(`  contratos marcados vencidos:  ${result.expiredMarked}`);
    if (result.errors.length > 0) {
      console.error(`  errores (${result.errors.length}):`);
      for (const err of result.errors) console.error(`   - ${err}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('contracts:check-expiry falló:', err);
  process.exitCode = 1;
});

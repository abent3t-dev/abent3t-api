/**
 * Fase §15: ejecuta manualmente el chequeo de vencimientos de contratos
 * (misma lógica que el cron de las 08:00 CDMX). Idempotente por diseño
 * (UNIQUE contract_id + tipo + destinatario): correrlo varias veces el mismo
 * día no re-envía nada.
 *
 * J2 (2026-10-01): un resumen diario por persona; los vencidos históricos no
 * alertan. J1: el resumen va a la cola de correo (bitácora en Compras →
 * Correo); lo envía el worker del api según EMAIL_TRANSPORT (simulación por
 * defecto: queda "simulado" y no sale nada).
 *
 * USO:  npm run contracts:check-expiry
 */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { EmailService } from '../src/email/email.service';
import { EmailOutboxService } from '../src/email/email-outbox.service';
import { EmailTransportService } from '../src/email/email-transport.service';
import { ContractExpiryService } from '../src/contracts/contract-expiry.service';

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    // J1: el resumen se ENCOLA; lo envía el worker del api (ritmo y tope)
    const config = new ConfigService();
    const transport = new EmailTransportService(config);
    const email = new EmailService(
      config,
      new EmailOutboxService(prisma, config, transport),
      transport,
    );
    const service = new ContractExpiryService(
      prisma,
      email,
      new ConfigService(),
    );
    const result = await service.runCheck();
    console.log('Chequeo de vencimientos (§15, J2 resumen diario):');
    console.log(`  contratos revisados:          ${result.checkedContracts}`);
    console.log(`  contratos en los resúmenes:   ${result.alertingContracts}`);
    console.log(`  vencidos históricos (sin aviso): ${result.historicSkipped}`);
    console.log(
      `  resúmenes a la cola (uno por persona): ${result.digestsQueued}`,
    );
    console.log(`  rechazados (dominio externo): ${result.digestsRejected}`);
    console.log(
      `  personas que ya tenían el de hoy: ${result.alreadyNotified}`,
    );
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

/**
 * Fase Expeditación: corre a mano el job de alertas (-15/vencida/+7, T9).
 * Idempotente (UNIQUE tracking+tipo+fecha): repetirlo el mismo día no
 * re-envía. Sin credenciales AZURE_* los correos se SIMULAN en el log.
 *
 * USO:  npm run expediting:check            (hoy)
 *       npm run expediting:check -- 2026-10-01   (fecha simulada, para pruebas)
 */
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { EmailService } from '../src/email/email.service';
import { ExpeditingService } from '../src/expediting/expediting.service';

async function main(): Promise<void> {
  const arg = process.argv[2];
  const now = arg ? new Date(`${arg}T12:00:00-06:00`) : new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Fecha inválida: ${arg} (usa YYYY-MM-DD)`);
  }
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const service = new ExpeditingService(
      prisma,
      new EmailService(new ConfigService()),
    );
    const result = await service.runAlertCheck(now);
    console.log('Alertas de expeditación:');
    console.log(`  órdenes revisadas: ${result.checked}`);
    console.log(`  alertas enviadas:  ${result.sent}`);
    console.log(`  ya enviadas hoy:   ${result.alreadySent}`);
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
  console.error('expediting:check falló:', err);
  process.exitCode = 1;
});

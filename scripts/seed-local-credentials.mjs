// scripts/seed-local-credentials.mjs
//
// Setea una contraseña local de DESARROLLO para todos los perfiles
// existentes. Solo para usar mientras Entra ID no esté configurado.
//
// Default: password = "password123" para todos, must_change_password=true.
// Cuando el usuario haga login, el frontend lo forzará a cambiarla.
//
// Uso:
//   node scripts/seed-local-credentials.mjs [password-opcional]

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const DEFAULT_PASSWORD = process.argv[2] || 'password123';
const ROUNDS = 10;

async function main() {
  const prisma = new PrismaClient();
  const hash = await bcrypt.hash(DEFAULT_PASSWORD, ROUNDS);

  const profiles = await prisma.profiles.findMany({
    where: { is_active: true },
    select: { id: true, email: true },
    orderBy: { email: 'asc' },
  });

  console.log(`Seteando password "${DEFAULT_PASSWORD}" para ${profiles.length} perfiles activos…\n`);

  for (const p of profiles) {
    await prisma.local_credentials.upsert({
      where: { profile_id: p.id },
      create: {
        profile_id: p.id,
        password_hash: hash,
        must_change_password: true,
        is_active: true,
      },
      update: {
        password_hash: hash,
        password_set_at: new Date(),
        must_change_password: true,
        is_active: true,
        failed_attempts: 0,
        locked_until: null,
      },
    });
    console.log(`  ✓ ${p.email}`);
  }

  console.log(`\n✅ Hecho. Todos pueden loguearse con password: "${DEFAULT_PASSWORD}"`);
  console.log('   (must_change_password=true → forzará cambio al primer login)');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});

// scripts/smoke-prisma.mjs
// Smoke test: confirma que Prisma puede conectar a abent3t_db y leer datos.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const [users, depts, enrollments, evidences, courses] = await Promise.all([
    prisma.profiles.findMany({
      select: { email: true, role: true, pending_first_login: true, departments: { select: { name: true } } },
      orderBy: { email: 'asc' },
    }),
    prisma.departments.count({ where: { is_active: true } }),
    prisma.platform_enrollments.count(),
    prisma.enrollment_evidences.count(),
    prisma.courses.count({ where: { is_active: true } }),
  ]);

  console.log('— profiles:', users.length);
  for (const u of users) {
    console.log(`   ${u.email.padEnd(35)} ${String(u.role).padEnd(20)} dept=${u.departments?.name ?? 'NULL'} pending=${u.pending_first_login}`);
  }
  console.log('— departments active:', depts);
  console.log('— platform_enrollments:', enrollments);
  console.log('— enrollment_evidences:', evidences);
  console.log('— courses active:', courses);

  // Test relations (joins)
  const oneEnrollment = await prisma.course_enrollments.findFirst({
    include: {
      profiles: { select: { email: true, full_name: true } },
      course_editions: { include: { courses: { select: { name: true, cost: true } } } },
    },
  });
  console.log('— sample course_enrollment join:');
  console.log('  ', JSON.stringify(oneEnrollment, null, 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error('❌', err);
    return prisma.$disconnect().then(() => process.exit(1));
  });

import { NestFactory } from '@nestjs/core';
import { LogLevel, ValidationPipe } from '@nestjs/common';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

/**
 * Parsea FRONTEND_URL en una lista de orígenes permitidos para CORS.
 * Acepta una sola URL o varias separadas por coma.
 *   FRONTEND_URL=http://localhost:3000
 *   FRONTEND_URL=https://app.abent3t.com,https://staging.abent3t.com
 *
 * Si no se configura, default a localhost:3000 para desarrollo.
 */
function getAllowedOrigins(): string[] {
  const raw = process.env.FRONTEND_URL?.trim();
  if (!raw) return ['http://localhost:3000'];
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * Niveles de log por entorno (mecanismo estándar de Nest: `logger: [...]`).
 * En producción se excluyen `debug` y `verbose`: las integraciones externas
 * emiten nombres de headers en debug y no aportan en operación. En el resto
 * de entornos se conservan los cinco niveles (comportamiento previo).
 */
function getLogLevels(): LogLevel[] {
  return process.env.NODE_ENV === 'production'
    ? ['error', 'warn', 'log']
    : ['error', 'warn', 'log', 'debug', 'verbose'];
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: getLogLevels() });

  app.setGlobalPrefix('api');

  // Headers de seguridad. Por defecto helmet activa CSP, HSTS,
  // X-Frame-Options=DENY, X-Content-Type-Options=nosniff, etc.
  app.use(helmet());

  // Cookie parser para JWT en cookies HttpOnly (Fase 2).
  app.use(cookieParser());

  // Limitar tamaño del body para evitar DoS por payloads gigantes.
  // 1MB cubre con margen los DTOs reales del sistema; los uploads de archivo
  // pasan por Multer (multipart) que tiene su propio límite por endpoint.
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.enableCors({
    origin: getAllowedOrigins(),
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  await app.listen(process.env.PORT ?? 3001);
}
bootstrap();

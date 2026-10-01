import * as Joi from 'joi';

/**
 * Schema de validación de variables de entorno (Fase 0 — T1, cierra H4).
 *
 * Reglas:
 * - Secretos y conexiones: requeridos SIEMPRE, sin default. Si faltan, la app
 *   NO arranca (fail-fast con el nombre de la variable en el error).
 * - Variables operativas: opcionales con el MISMO default que usa el código,
 *   para que un `.env` completo arranque idéntico a antes del schema.
 * - Integraciones futuras (Maximo/SAP): solo se declaran aquí; los clientes
 *   se implementan en fases posteriores.
 *
 * La lista se construyó buscando `process.env.` y `configService.get` en
 * `src/` — si un módulo nuevo lee una variable, debe agregarse aquí.
 */
export const envValidationSchema = Joi.object({
  // ===== Núcleo =====
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3001),
  FRONTEND_URL: Joi.string().default('http://localhost:3000'), // una URL o varias separadas por coma

  // ===== Base de datos (Prisma) =====
  DATABASE_URL: Joi.string()
    .pattern(/^postgres(ql)?:\/\//)
    .required()
    .messages({
      'any.required': 'DATABASE_URL es requerida (conexión PostgreSQL)',
      'string.pattern.base': 'DATABASE_URL debe iniciar con postgresql://',
    }),

  // ===== Autenticación (JWT propio) =====
  JWT_SECRET: Joi.string().required().messages({
    'any.required': 'JWT_SECRET es requerida (firma del JWT propio)',
    'string.empty': 'JWT_SECRET no puede estar vacía',
  }),
  JWT_EXPIRES_IN: Joi.string().default('8h'),
  REFRESH_TOKEN_EXPIRES_IN: Joi.string().default('7d'),
  ALLOW_LOCAL_LOGIN: Joi.boolean().default(false),
  ALLOWED_EMAIL_DOMAIN: Joi.string().optional(),

  // ===== Microsoft Entra ID (OIDC) — pendiente de credenciales de TI =====
  AZURE_AD_TENANT_ID: Joi.string().allow('').optional(),
  AZURE_AD_CLIENT_ID: Joi.string().allow('').optional(),
  AZURE_AD_CLIENT_SECRET: Joi.string().allow('').optional(),
  AZURE_AD_REDIRECT_URI: Joi.string().allow('').optional(),

  // ===== Storage (MinIO S3-compatible) =====
  MINIO_ENDPOINT: Joi.string().required(),
  MINIO_PORT: Joi.number().port().required(),
  MINIO_USE_SSL: Joi.boolean().required(),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  // El SDK exige region pero MinIO la ignora; mismo default que el código.
  MINIO_REGION: Joi.string().default('us-east-1'),
  MINIO_BUCKET_EVIDENCES: Joi.string().required(),
  MINIO_BUCKET_PROPOSALS: Joi.string().required(),
  // §15: con default para no romper .env existentes (el compose lo crea)
  MINIO_BUCKET_CONTRACTS: Joi.string().default('contracts'),
  // §16: mismo criterio
  MINIO_BUCKET_COMMITTEES: Joi.string().default('purchase-committees'),

  // ===== Cifrado de credenciales de integraciones =====
  PLATFORM_ENCRYPTION_KEY: Joi.string().min(32).required().messages({
    'any.required':
      'PLATFORM_ENCRYPTION_KEY es requerida (cifrado de credenciales de integraciones)',
    'string.min': 'PLATFORM_ENCRYPTION_KEY debe tener al menos 32 caracteres',
  }),

  // ===== Rate limiting =====
  THROTTLE_TTL_MS: Joi.number().integer().positive().default(60_000),
  THROTTLE_LIMIT: Joi.number().integer().positive().default(100),

  // ===== Correo (J1, hilo con César 2026-10-01) =====
  // Todo correo pasa por la cola (`email_outbox`). `simulacion` (default) no
  // envía nada: queda "simulado" en la bitácora. El envío real se habilita
  // cambiando esto a propósito, nunca solo por tener credenciales.
  EMAIL_TRANSPORT: Joi.string()
    .trim()
    .lowercase()
    .valid('simulacion', 'graph', 'smtp')
    .default('simulacion')
    .messages({
      'any.only': 'EMAIL_TRANSPORT debe ser simulacion, graph o smtp',
    }),
  // Remitente fijo (si falta, AZURE_EMAIL_FROM). Con smtp es obligatorio:
  // el dominio remitente autorizado en el relay (SPF y DKIM).
  EMAIL_FROM: Joi.string()
    .email({ tlds: { allow: false } })
    .allow('')
    .when('EMAIL_TRANSPORT', {
      is: 'smtp',
      then: Joi.string()
        .email({ tlds: { allow: false } })
        .invalid('')
        .required()
        .messages({
          'any.required': 'EMAIL_FROM es requerida con EMAIL_TRANSPORT=smtp',
          'any.invalid':
            'EMAIL_FROM no puede estar vacía con EMAIL_TRANSPORT=smtp',
        }),
    }),
  // Ritmo: un correo cada N segundos (César pidió 120)
  EMAIL_MIN_INTERVAL_SECONDS: Joi.number()
    .integer()
    .min(1)
    .max(3600)
    .default(120),
  // Tope diario: al llegar, el envío se pausa solo hasta el día siguiente
  EMAIL_DAILY_CAP: Joi.number().integer().min(1).max(10_000).default(100),

  // Microsoft Graph (EMAIL_TRANSPORT=graph): app con Mail.Send en Entra
  AZURE_TENANT_ID: Joi.string()
    .allow('')
    .when('EMAIL_TRANSPORT', {
      is: 'graph',
      then: Joi.string().invalid('').required().messages({
        'any.required':
          'AZURE_TENANT_ID es requerida con EMAIL_TRANSPORT=graph',
        'any.invalid':
          'AZURE_TENANT_ID no puede estar vacía con EMAIL_TRANSPORT=graph',
      }),
    }),
  AZURE_CLIENT_ID: Joi.string()
    .allow('')
    .when('EMAIL_TRANSPORT', {
      is: 'graph',
      then: Joi.string().invalid('').required().messages({
        'any.required':
          'AZURE_CLIENT_ID es requerida con EMAIL_TRANSPORT=graph',
        'any.invalid':
          'AZURE_CLIENT_ID no puede estar vacía con EMAIL_TRANSPORT=graph',
      }),
    }),
  AZURE_CLIENT_SECRET: Joi.string()
    .allow('')
    .when('EMAIL_TRANSPORT', {
      is: 'graph',
      then: Joi.string().invalid('').required().messages({
        'any.required':
          'AZURE_CLIENT_SECRET es requerida con EMAIL_TRANSPORT=graph',
        'any.invalid':
          'AZURE_CLIENT_SECRET no puede estar vacía con EMAIL_TRANSPORT=graph',
      }),
    }),
  AZURE_EMAIL_FROM: Joi.string().allow('').default('noreply@abent3t.com'),

  // Relay SMTP (EMAIL_TRANSPORT=smtp, J3): sin Mail.Send en Entra
  SMTP_HOST: Joi.string()
    .allow('')
    .when('EMAIL_TRANSPORT', {
      is: 'smtp',
      then: Joi.string().invalid('').required().messages({
        'any.required': 'SMTP_HOST es requerida con EMAIL_TRANSPORT=smtp',
        'any.invalid':
          'SMTP_HOST no puede estar vacía con EMAIL_TRANSPORT=smtp',
      }),
    }),
  SMTP_PORT: Joi.number().port().default(587),
  // true = TLS desde el inicio (465); false = STARTTLS (587), obligatorio
  // si hay usuario
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().allow('').optional(),
  SMTP_PASS: Joi.string()
    .allow('')
    .when('SMTP_USER', {
      is: Joi.string().min(1).required(),
      then: Joi.string().invalid('').required().messages({
        'any.required': 'SMTP_PASS es requerida si hay SMTP_USER',
        'any.invalid': 'SMTP_PASS no puede estar vacía si hay SMTP_USER',
      }),
    }),

  // ===== Recordatorios =====
  REMINDERS_ENABLED: Joi.boolean().default(true),
  REMINDER_FIRST_DAYS: Joi.number().integer().positive().default(3),
  REMINDER_FOLLOWUP_DAYS: Joi.number().integer().positive().default(7),
  REMINDER_ESCALATION_DAYS: Joi.number().integer().positive().default(14),
  // D11 (César, 2026-09-22): alerta de vencimiento de contratos desde N días
  // antes y DIARIA hasta que el contrato se renueve o cierre.
  CONTRACT_ALERT_DAYS_BEFORE: Joi.number()
    .integer()
    .min(1)
    .max(365)
    .default(45),

  // ===== Compras: import administrativo =====
  REQUISITIONS_IMPORT_MAX_BATCH: Joi.number().integer().positive().default(500),

  // ===== IBM Maximo (Fase 1-2; aquí solo la configuración) =====
  MAXIMO_SYNC_ENABLED: Joi.boolean().default(false),
  // Nota (Int-3): el `allow('')` de la base sobrevive al concat del `then` de
  // Joi, así que el fail-fast necesita `.invalid('')` explícito — sin él, una
  // variable PRESENTE PERO VACÍA pasaba la validación con el flag encendido.
  MAXIMO_BASE_URL: Joi.string()
    .uri()
    .allow('')
    .when('MAXIMO_SYNC_ENABLED', {
      is: true,
      then: Joi.string().uri().invalid('').required().messages({
        'any.required':
          'MAXIMO_BASE_URL es requerida cuando MAXIMO_SYNC_ENABLED=true',
        'any.invalid':
          'MAXIMO_BASE_URL no puede estar vacía cuando MAXIMO_SYNC_ENABLED=true',
      }),
    }),
  MAXIMO_OSLC_URL: Joi.string()
    .uri()
    .allow('')
    .when('MAXIMO_SYNC_ENABLED', {
      is: true,
      then: Joi.string().uri().invalid('').required().messages({
        'any.required':
          'MAXIMO_OSLC_URL es requerida cuando MAXIMO_SYNC_ENABLED=true',
        'any.invalid':
          'MAXIMO_OSLC_URL no puede estar vacía cuando MAXIMO_SYNC_ENABLED=true',
      }),
    }),
  MAXIMO_AUTH_TOKEN: Joi.string()
    .allow('')
    .when('MAXIMO_SYNC_ENABLED', {
      is: true,
      then: Joi.string().invalid('').required().messages({
        'any.required':
          'MAXIMO_AUTH_TOKEN es requerida cuando MAXIMO_SYNC_ENABLED=true',
        'any.invalid':
          'MAXIMO_AUTH_TOKEN no puede estar vacía cuando MAXIMO_SYNC_ENABLED=true',
      }),
    }),
  // Fase INT-2: AB_CONTRATOS queda deshabilitada hasta cerrar CONTRACTREFNUM /
  // CONTRACTVALUE con Isaac (CLAUDE_COMPRAS.md §20.2). Con false, los métodos
  // de contratos de MaximoClient fallan con error tipado sin tocar la red.
  MAXIMO_CONTRACTS_ENABLED: Joi.boolean().default(false),
  // Fase INT-3: sync a staging. Intervalo del cron (§20.A.3) y tamaño de
  // página del full scan legacy (T4). Solo aplican con MAXIMO_SYNC_ENABLED=true.
  // max 10080 (1 semana): sobre ~35 791 min el setInterval de Node desborda
  // el entero de 32 bits y dispararía continuamente.
  MAXIMO_SYNC_INTERVAL_MINUTES: Joi.number()
    .integer()
    .positive()
    .max(10_080)
    .default(60),
  MAXIMO_SYNC_PAGE_SIZE: Joi.number().integer().min(1).max(500).default(100),

  // ===== SAP Business One Service Layer (Int-4) =====
  SAP_SYNC_ENABLED: Joi.boolean().default(false),
  // Con el sync encendido, las SL_* pasan a ser obligatorias (mismo patrón
  // fail-fast que MAXIMO_*: `.invalid('')` porque el allow('') base
  // sobrevive al concat del `then`).
  SL_BASE_URL: Joi.string()
    .uri()
    .allow('')
    .when('SAP_SYNC_ENABLED', {
      is: true,
      then: Joi.string().uri().invalid('').required().messages({
        'any.required': 'SL_BASE_URL es requerida cuando SAP_SYNC_ENABLED=true',
        'any.invalid':
          'SL_BASE_URL no puede estar vacía cuando SAP_SYNC_ENABLED=true',
      }),
    }),
  SL_COMPANY_DB: Joi.string()
    .allow('')
    .when('SAP_SYNC_ENABLED', {
      is: true,
      then: Joi.string().invalid('').required().messages({
        'any.required':
          'SL_COMPANY_DB es requerida cuando SAP_SYNC_ENABLED=true',
        'any.invalid':
          'SL_COMPANY_DB no puede estar vacía cuando SAP_SYNC_ENABLED=true',
      }),
    }),
  SL_USER: Joi.string()
    .allow('')
    .when('SAP_SYNC_ENABLED', {
      is: true,
      then: Joi.string().invalid('').required().messages({
        'any.required': 'SL_USER es requerida cuando SAP_SYNC_ENABLED=true',
        'any.invalid':
          'SL_USER no puede estar vacía cuando SAP_SYNC_ENABLED=true',
      }),
    }),
  SL_PASSWORD: Joi.string()
    .allow('')
    .when('SAP_SYNC_ENABLED', {
      is: true,
      then: Joi.string().invalid('').required().messages({
        'any.required': 'SL_PASSWORD es requerida cuando SAP_SYNC_ENABLED=true',
        'any.invalid':
          'SL_PASSWORD no puede estar vacía cuando SAP_SYNC_ENABLED=true',
      }),
    }),
  // Sync a staging (Int-4). Mismo tope de intervalo que Maximo (overflow de
  // setInterval sobre ~35 791 min). Página chica a propósito: cada documento
  // pesa ~32 KB porque las líneas no se pueden proyectar.
  SAP_SYNC_INTERVAL_MINUTES: Joi.number()
    .integer()
    .positive()
    .max(10_080)
    .default(60),
  SAP_SYNC_PAGE_SIZE: Joi.number().integer().min(1).max(100).default(20),
  // Deshabilitar la verificación TLS solo se permite FUERA de producción.
  SL_REJECT_UNAUTHORIZED: Joi.boolean()
    .default(true)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.boolean().valid(true).messages({
        'any.only':
          'SL_REJECT_UNAUTHORIZED no puede ser false con NODE_ENV=production (verificación TLS obligatoria)',
      }),
    }),
});

/**
 * Opciones para que Nest reporte TODAS las variables con problema en un solo
 * arranque (no una por una) y tolere las vars ajenas del sistema operativo.
 */
export const envValidationOptions = {
  allowUnknown: true,
  abortEarly: false,
};

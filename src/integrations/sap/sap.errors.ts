/**
 * Errores tipados del cliente SAP (Fase INT-4). Los errores de transporte de
 * los GET (auth, 4xx, 5xx, timeout, red) se propagan tal cual desde
 * `IntegrationHttpClient` (Int-1); estos cubren lo específico de SAP.
 * Ninguno transporta credenciales ni cookies.
 */
export class SapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Faltan env vars para operar. El mensaje solo nombra las variables. */
export class SapNotConfiguredError extends SapError {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Integración SAP no configurada: faltan ${missing.join(', ')} (ver .env.example)`,
    );
    this.missing = missing;
  }
}

/**
 * El `POST /Login` del Service Layer falló. El mensaje incluye status y el
 * `error.message` que devolvió SAP (p. ej. "Tenant does not exist"), NUNCA
 * la contraseña ni el cuerpo enviado.
 */
export class SapLoginError extends SapError {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Login al Service Layer de SAP falló (HTTP ${status}): ${detail}`);
    this.status = status;
  }
}

/** El sobre de la respuesta no tiene la forma esperada (`value` ausente, etc.). */
export class SapResponseShapeError extends SapError {
  constructor(detail: string) {
    super(`Respuesta de SAP con forma inesperada: ${detail}`);
  }
}

/** Un documento crudo no puede mapearse (p. ej. sin DocEntry numérico). */
export class SapMappingError extends SapError {
  readonly field: string;

  constructor(detail: string, field: string) {
    super(`No se pudo mapear el documento de SAP (${field}): ${detail}`);
    this.field = field;
  }
}

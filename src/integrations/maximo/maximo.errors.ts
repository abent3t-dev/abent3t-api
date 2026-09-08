import { MaximoObjectStructure } from './dto/maximo-raw.types';

/**
 * Errores tipados del cliente/mapper de Maximo (Fase INT-2). Los errores de
 * transporte (auth, 4xx, 5xx, timeout, red) se propagan tal cual desde
 * `IntegrationHttpClient` (Int-1); estos cubren lo específico de Maximo.
 * Ninguno transporta credenciales.
 */
export class MaximoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Faltan env vars para operar. El mensaje solo nombra las variables. */
export class MaximoNotConfiguredError extends MaximoError {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `Integración Maximo no configurada: faltan ${missing.join(', ')} (ver .env.example)`,
    );
    this.missing = missing;
  }
}

/** `MAXIMO_CONTRACTS_ENABLED=false`: AB_CONTRATOS deshabilitada (§20.2). */
export class MaximoContractsDisabledError extends MaximoError {
  constructor() {
    super(
      'Lectura de AB_CONTRATOS deshabilitada (MAXIMO_CONTRACTS_ENABLED=false) hasta cerrar CONTRACTREFNUM/CONTRACTVALUE con CIISA',
    );
  }
}

/**
 * H5: Maximo acepta parámetros inválidos EN SILENCIO. Tras cada lectura con
 * filtro de igualdad se verifica que lo recibido cumple lo pedido; si no,
 * se lanza este error (los filtros de rango solo generan warning + metadato).
 */
export class MaximoFilterNotAppliedError extends MaximoError {
  readonly objectStructure: MaximoObjectStructure;
  readonly filter: string;
  readonly expected: string;
  readonly received: readonly string[];

  constructor(ctx: {
    objectStructure: MaximoObjectStructure;
    filter: string;
    expected: string;
    received: readonly string[];
  }) {
    super(
      `Maximo ignoró el filtro ${ctx.filter}=${ctx.expected} en ${ctx.objectStructure}: recibido ${
        ctx.received.length ? ctx.received.join(', ') : '(vacío)'
      }`,
    );
    this.objectStructure = ctx.objectStructure;
    this.filter = ctx.filter;
    this.expected = ctx.expected;
    this.received = ctx.received;
  }
}

/** El sobre de la respuesta no tiene la forma esperada (o es un `Error` OSLC). */
export class MaximoResponseShapeError extends MaximoError {
  readonly reasonCode: string | null;

  constructor(detail: string, reasonCode: string | null = null) {
    super(`Respuesta de Maximo con forma inesperada: ${detail}`);
    this.reasonCode = reasonCode;
  }
}

/** Un registro crudo no puede mapearse (p. ej. sin PONUM). */
export class MaximoMappingError extends MaximoError {
  readonly field: string;

  constructor(detail: string, field: string) {
    super(`No se pudo mapear el registro de Maximo (${field}): ${detail}`);
    this.field = field;
  }
}

/** Argumento inválido para una lectura (p. ej. PONUM con caracteres raros). */
export class MaximoInvalidArgumentError extends MaximoError {}

import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import {
  AVANCE_REPORTES,
  type AvanceReporte,
} from '../avance-semanal/avance-semanal.engine';
import {
  AVANCE_CORTES,
  AVANCE_DIAS_TIPOS,
  AVANCE_GESTIONES_MAXIMO,
  AVANCE_INICIOS,
  AVANCE_MONTOS_FUENTES,
  AVANCE_PROMEDIOS_TITULO,
  AVANCE_TIPOS_CAMBIO,
  type AvanceCorte,
  type AvanceDiasTipo,
  type AvanceGestionMaximo,
  type AvanceInicio,
  type AvanceMontosFuente,
  type AvancePromedioTitulo,
  type AvanceTipoCambio,
} from '../avance-semanal/avance-semanal.reglas';

/**
 * H1 — Reporte de avance semanal. `semana` = cualquier día de la semana (se
 * toma su lunes; default: la última semana completa). `desde`/`hasta` = una
 * página por semana (el "acumulado"). I3: `fuente` default `ambos` (una
 * página de Maximo y una de SAP por semana); `maximo`, `sap` o `todas` (las
 * dos sumadas, solo API) dan una página por semana. O2: sale `grupos` (la
 * vista previa de L2); el ValidationPipe (whitelist) lo descarta si llega.
 */
export class AvanceSemanalDto {
  @IsISO8601()
  @IsOptional()
  semana?: string;

  @IsISO8601()
  @IsOptional()
  desde?: string;

  @IsISO8601()
  @IsOptional()
  hasta?: string;

  @IsIn(AVANCE_REPORTES)
  @IsOptional()
  fuente?: AvanceReporte;
}

/**
 * K5.7 — Conciliación contra la serie de Jorge con una variante de las
 * reglas. Todo opcional: lo que no viene toma el default (`AVANCE_REGLAS` y
 * `AVANCE_MONTOS_FUENTE_MAXIMO`). `dias_tipo` (H3) = naturales | habiles.
 */
export class AvanceConciliacionDto {
  /** Recibida de Maximo: primer APPR o ISSUEDATE. */
  @IsIn(AVANCE_INICIOS)
  @IsOptional()
  recibida?: AvanceInicio;

  /** Inicio de los días de cierre y cancelación de Maximo. */
  @IsIn(AVANCE_INICIOS)
  @IsOptional()
  dias_desde?: AvanceInicio;

  /** OC de la página de Maximo: las suyas o las de SAP migradas. */
  @IsIn(AVANCE_MONTOS_FUENTES)
  @IsOptional()
  montos?: AvanceMontosFuente;

  /** Corte de la semana: domingo o viernes (23:59 hora de México). */
  @IsIn(AVANCE_CORTES)
  @IsOptional()
  corte?: AvanceCorte;

  /**
   * H3: días de cierre y cancelación naturales o hábiles (lunes a viernes
   * sin los festivos de `holidays`). Declarado aquí porque el
   * ValidationPipe (whitelist) descarta en silencio lo no declarado.
   */
  @IsIn(AVANCE_DIAS_TIPOS)
  @IsOptional()
  dias_tipo?: AvanceDiasTipo;

  /**
   * O1: tipo de cambio de las OC de Maximo en dólares y euros: el de Maximo
   * del día o el de referencia de SAP del mes (los montos de la
   * conciliación traen los dos de todos modos).
   */
  @IsIn(AVANCE_TIPOS_CAMBIO)
  @IsOptional()
  tipo_cambio?: AvanceTipoCambio;

  /** O1.3: el promedio de días que se compara: el del año o el de la semana. */
  @IsIn(AVANCE_PROMEDIOS_TITULO)
  @IsOptional()
  promedio_titulo?: AvancePromedioTitulo;

  /**
   * O2: las gestiones de Maximo de la variante: 'pr' (PR aprobadas) o 'rq'
   * (solicitudes de cotización). Sin el parámetro, las de la página (el
   * flag MAXIMO_RFQS_ENABLED); con 'rq' y sin RQ sincronizadas, salen las PR
   * y la respuesta lo dice (`gestion_maximo`).
   */
  @IsIn(AVANCE_GESTIONES_MAXIMO)
  @IsOptional()
  gestion?: AvanceGestionMaximo;
}

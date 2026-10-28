import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * FP&A (B2) — versiones y sus parámetros (documentation/FPA.md, "Bloque B:
 * avance"). Los números viajan como texto decimal para no perder decimales;
 * también se aceptan números.
 */

// Uno por columna de la base: inflación numeric(6,3) (0 a <100), tipo de
// cambio numeric(18,6) (> 0), tarifas numeric(15,2) (>= 0)
const INFLATION = /^\d{1,2}(\.\d{1,3})?$/;
const RATE = /^\d{1,12}(\.\d{1,6})?$/;
const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

const toDecimalText = ({ value }: { value: unknown }) =>
  value === null || value === undefined || value === ''
    ? null
    : typeof value === 'number'
      ? String(value)
      : value;

const toTrimmedOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ') || null
    : (value ?? null);

export class FpaCreateVersionDto {
  @Transform(toTrimmedOrNull)
  @IsString({ message: 'La clave es obligatoria (p. ej. B-27)' })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,19}$/, {
    message:
      'La clave lleva hasta 20 letras, números, espacios, puntos, guiones o guiones bajos (p. ej. B-27 o F2-26)',
  })
  code: string;

  @Transform(toTrimmedOrNull)
  @IsString({ message: 'El nombre es obligatorio (p. ej. Presupuesto 2027)' })
  @MaxLength(120, { message: 'El nombre lleva hasta 120 caracteres' })
  name: string;

  @Type(() => Number)
  @IsInt({ message: 'El ejercicio es un año (p. ej. 2027)' })
  @Min(2020, { message: 'El ejercicio es un año entre 2020 y 2100' })
  @Max(2100, { message: 'El ejercicio es un año entre 2020 y 2100' })
  fiscal_year: number;

  @IsIn(['presupuesto', 'forecast', 'comparacion'], {
    message: 'Elige el tipo: presupuesto, forecast o comparación',
  })
  kind: 'presupuesto' | 'forecast' | 'comparacion';

  @IsOptional()
  @ValidateIf((o: FpaCreateVersionDto) => o.cutoff_month !== null)
  @Type(() => Number)
  @IsInt({ message: 'El mes de corte va de 1 (enero) a 11 (noviembre)' })
  @Min(1, { message: 'El mes de corte va de 1 (enero) a 11 (noviembre)' })
  @Max(11, { message: 'El mes de corte va de 1 (enero) a 11 (noviembre)' })
  cutoff_month?: number | null;

  /** Versión de la que se copian los parámetros (no las líneas). */
  @IsOptional()
  @ValidateIf((o: FpaCreateVersionDto) => o.copy_params_from !== null)
  @IsUUID('all', {
    message: 'La versión de la que se copian los parámetros no es válida',
  })
  copy_params_from?: string | null;
}

export class FpaUpdateVersionDto {
  @IsOptional()
  @Transform(toTrimmedOrNull)
  @IsString({ message: 'El nombre no puede quedar vacío' })
  @MaxLength(120, { message: 'El nombre lleva hasta 120 caracteres' })
  name?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : (value ?? null),
  )
  @ValidateIf((o: FpaUpdateVersionDto) => o.notes !== null)
  @IsString({ message: 'Las notas van en texto' })
  @MaxLength(2000, { message: 'Las notas llevan hasta 2,000 caracteres' })
  notes?: string | null;
}

export class FpaExchangeRateInputDto {
  @Matches(/^[A-Z]{3}$/, {
    message: 'La moneda va en código ISO de 3 letras (USD, EUR)',
  })
  currency: string;

  @Transform(toDecimalText)
  @IsString({ message: 'Falta el tipo de cambio' })
  @Matches(RATE, {
    message: 'El tipo de cambio es un número mayor a 0, con hasta 6 decimales',
  })
  rate_mxn: string;
}

export class FpaTravelRateInputDto {
  @IsIn(['nacional', 'internacional'], {
    message: 'El tipo de viaje es nacional o internacional',
  })
  trip_type: 'nacional' | 'internacional';

  @IsIn(['colaborador', 'director'], {
    message: 'El tipo de viajero es colaborador o director',
  })
  traveler_type: 'colaborador' | 'director';

  @Transform(toDecimalText)
  @IsString({ message: 'Falta el vuelo por persona' })
  @Matches(AMOUNT, { message: 'Las tarifas llevan hasta 2 decimales' })
  flight_per_person: string;

  @Transform(toDecimalText)
  @IsString({ message: 'Falta el hotel por noche' })
  @Matches(AMOUNT, { message: 'Las tarifas llevan hasta 2 decimales' })
  hotel_per_night: string;

  @Transform(toDecimalText)
  @IsString({ message: 'Falta el transporte por día' })
  @Matches(AMOUNT, { message: 'Las tarifas llevan hasta 2 decimales' })
  transport_per_day: string;

  @Transform(toDecimalText)
  @IsString({ message: 'Faltan los alimentos por día' })
  @Matches(AMOUNT, { message: 'Las tarifas llevan hasta 2 decimales' })
  meals_per_day: string;
}

/**
 * PUT /fpa/versiones/:id/parametros: el juego completo de parámetros. Lo que
 * no viene se da de baja (una moneda o una tarifa que se quitó).
 */
export class FpaVersionParamsDto {
  @IsOptional()
  @Transform(toDecimalText)
  @ValidateIf((o: FpaVersionParamsDto) => o.inflation_pct !== null)
  @Matches(INFLATION, {
    message:
      'La inflación es un porcentaje de 0 a 99.999, con hasta 3 decimales',
  })
  inflation_pct?: string | null;

  @IsOptional()
  @ValidateIf((o: FpaVersionParamsDto) => o.cutoff_month !== null)
  @Type(() => Number)
  @IsInt({ message: 'El mes de corte va de 1 (enero) a 11 (noviembre)' })
  @Min(1, { message: 'El mes de corte va de 1 (enero) a 11 (noviembre)' })
  @Max(11, { message: 'El mes de corte va de 1 (enero) a 11 (noviembre)' })
  cutoff_month?: number | null;

  @IsOptional()
  @Transform(toTrimmedOrNull)
  @ValidateIf((o: FpaVersionParamsDto) => o.params_source !== null)
  @IsString({ message: 'La fuente va en texto' })
  @MaxLength(200, { message: 'La fuente lleva hasta 200 caracteres' })
  params_source?: string | null;

  @IsArray({
    message: 'Faltan los tipos de cambio (una lista, aunque vaya vacía)',
  })
  @ArrayMaxSize(20, { message: 'Hasta 20 monedas por versión' })
  @ValidateNested({ each: true })
  @Type(() => FpaExchangeRateInputDto)
  exchange_rates: FpaExchangeRateInputDto[];

  @IsArray({
    message: 'Faltan las tarifas de viaje (una lista, aunque vaya vacía)',
  })
  @ArrayMaxSize(4, { message: 'Son cuatro tarifas de viaje como máximo' })
  @ValidateNested({ each: true })
  @Type(() => FpaTravelRateInputDto)
  travel_rates: FpaTravelRateInputDto[];

  /** Hash de los parámetros que tenía la pantalla: si cambiaron, 409. */
  @IsOptional()
  @IsString({ message: 'El hash de los parámetros no es válido' })
  @MaxLength(64, { message: 'El hash de los parámetros no es válido' })
  expected_hash?: string;
}

export class FpaApproveParamsDto {
  /** Hash de los parámetros que revisó quien da el visto bueno. */
  @IsString({ message: 'Faltan los parámetros que revisaste' })
  @MaxLength(64, { message: 'El hash de los parámetros no es válido' })
  params_hash: string;
}

export class FpaVersionCommentDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : (value ?? null),
  )
  @ValidateIf((o: FpaVersionCommentDto) => o.comment !== null)
  @IsString({ message: 'El comentario va en texto' })
  @MaxLength(1000, { message: 'El comentario lleva hasta 1,000 caracteres' })
  comment?: string | null;
}

export class FpaReopenVersionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString({ message: 'Escribe por qué se reabre la versión' })
  @MinLength(10, {
    message: 'Escribe por qué se reabre la versión (al menos 10 caracteres)',
  })
  @MaxLength(1000, { message: 'El comentario lleva hasta 1,000 caracteres' })
  comment: string;
}

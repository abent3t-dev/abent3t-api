import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * FP&A (A3) — línea del formato único (documentation/FPA.md, "Formato único
 * de captura" §2.2). Los montos y precios viajan como texto decimal para no
 * perder centavos; también se aceptan números.
 */

// Uno por columna de la base, para no redondear en silencio ni desbordar:
// veces numeric(12,4) (sin negativos), precio numeric(15,4), monto numeric(15,2)
const QUANTITY = /^\d{1,8}(\.\d{1,4})?$/;
const PRICE = /^-?\d{1,11}(\.\d{1,4})?$/;
const AMOUNT = /^-?\d{1,13}(\.\d{1,2})?$/;
const QUANTITY_MSG =
  'Las veces deben ser un número mayor o igual a 0, con hasta 4 decimales';
const PRICE_MSG = 'El precio debe ser un número con hasta 4 decimales';
const AMOUNT_MSG = 'El monto debe ser un número con hasta 2 decimales';

/** Normaliza un decimal opcional: '' / undefined → null; número → texto. */
const toDecimalText = ({ value }: { value: unknown }) =>
  value === null || value === undefined || value === ''
    ? null
    : typeof value === 'number'
      ? String(value)
      : value;

const toTrimmedOrNull = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || null : (value ?? null);

export class FpaMonthInputDto {
  @IsInt()
  @Min(1)
  @Max(12)
  month: number;

  @IsOptional()
  @Transform(toDecimalText)
  @ValidateIf((o: FpaMonthInputDto) => o.quantity !== null)
  @Matches(QUANTITY, { message: QUANTITY_MSG })
  quantity?: string | null;

  @IsOptional()
  @Transform(toDecimalText)
  @ValidateIf((o: FpaMonthInputDto) => o.unit_price !== null)
  @Matches(PRICE, { message: PRICE_MSG })
  unit_price?: string | null;

  @IsOptional()
  @Transform(toDecimalText)
  @ValidateIf((o: FpaMonthInputDto) => o.amount !== null)
  @Matches(AMOUNT, { message: AMOUNT_MSG })
  amount?: string | null;

  @IsOptional()
  @ValidateIf((o: FpaMonthInputDto) => o.trips !== null)
  @IsInt()
  @Min(1)
  @Max(999)
  trips?: number | null;
}

export class FpaTripInputDto {
  @IsIn(['nacional', 'internacional'])
  trip_type: 'nacional' | 'internacional';

  @IsInt()
  @Min(0)
  @Max(999)
  travelers_colaborador: number;

  @IsInt()
  @Min(0)
  @Max(999)
  travelers_director: number;

  @IsInt()
  @Min(0)
  @Max(365)
  nights: number;

  @IsBoolean()
  car_rental: boolean;
}

export class FpaLineInputDto {
  @IsUUID()
  department_id: string;

  @IsUUID()
  classification_id: string;

  @Transform(toTrimmedOrNull)
  @IsString({ message: 'El concepto es obligatorio' })
  @MaxLength(255)
  concept: string;

  @IsOptional()
  @Transform(toTrimmedOrNull)
  @IsString()
  @MaxLength(4000)
  justification?: string | null;

  @IsOptional()
  @ValidateIf((o: FpaLineInputDto) => o.supplier_id !== null)
  @IsUUID()
  supplier_id?: string | null;

  @IsOptional()
  @Transform(toTrimmedOrNull)
  @ValidateIf((o: FpaLineInputDto) => o.supplier_name !== null)
  @IsString()
  @MaxLength(255)
  supplier_name?: string | null;

  @IsOptional()
  @ValidateIf((o: FpaLineInputDto) => o.priority !== null)
  @IsIn(['contractual', 'necesario', 'deseable'])
  priority?: 'contractual' | 'necesario' | 'deseable' | null;

  @IsIn(['precio_veces', 'monto_mes', 'viaje'], {
    message: 'Elige la forma de cálculo',
  })
  calc_method: 'precio_veces' | 'monto_mes' | 'viaje';

  @Matches(/^[A-Z]{3}$/, { message: 'Elige la moneda' })
  currency: string;

  @IsIn(['precio_acordado', 'inflacion'], { message: 'Elige el índice' })
  price_index: 'precio_acordado' | 'inflacion';

  @IsOptional()
  @Transform(toDecimalText)
  @ValidateIf((o: FpaLineInputDto) => o.unit_price !== null)
  @Matches(PRICE, { message: PRICE_MSG })
  unit_price?: string | null;

  @IsOptional()
  @ValidateIf((o: FpaLineInputDto) => o.trip !== null)
  @ValidateNested()
  @Type(() => FpaTripInputDto)
  trip?: FpaTripInputDto | null;

  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => FpaMonthInputDto)
  months: FpaMonthInputDto[];

  @IsOptional()
  @Transform(toTrimmedOrNull)
  @ValidateIf((o: FpaLineInputDto) => o.contract_label !== null)
  @IsString()
  @MaxLength(120)
  contract_label?: string | null;

  @IsOptional()
  @Transform(toTrimmedOrNull)
  @ValidateIf((o: FpaLineInputDto) => o.project_tag !== null)
  @IsString()
  @MaxLength(60)
  project_tag?: string | null;

  @IsOptional()
  @ValidateIf((o: FpaLineInputDto) => o.outside_ebitda !== null)
  @IsBoolean()
  outside_ebitda?: boolean | null;

  @IsOptional()
  @ValidateIf((o: FpaLineInputDto) => o.spend_type !== null)
  @IsIn(['recurrente', 'extraordinario', 'inversion'])
  spend_type?: 'recurrente' | 'extraordinario' | 'inversion' | null;
}

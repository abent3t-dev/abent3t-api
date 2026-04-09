import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class UpdatePurchaseTypeDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string;

  @IsBoolean()
  @IsOptional()
  requires_contract?: boolean;

  @IsString()
  @IsOptional()
  description?: string;

  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}

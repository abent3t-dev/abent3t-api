import { IsString, IsNotEmpty, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class CreatePurchaseTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  key: string;

  @IsBoolean()
  @IsOptional()
  requires_contract?: boolean;

  @IsString()
  @IsOptional()
  description?: string;
}

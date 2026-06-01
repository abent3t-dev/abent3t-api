import { IsString, MinLength, MaxLength, IsOptional, IsBoolean } from 'class-validator';

export class SetLocalCredentialsDto {
  @IsString()
  @MinLength(6, { message: 'La contraseña debe tener al menos 6 caracteres' })
  @MaxLength(200)
  password: string;

  /**
   * Si true, marca al usuario como `must_change_password = true` — el front
   * lo forzará a cambiarla en su próximo login. Útil cuando admin_rh asigna
   * una contraseña temporal.
   */
  @IsOptional()
  @IsBoolean()
  must_change_password?: boolean;
}

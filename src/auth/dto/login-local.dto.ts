import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class LoginLocalDto {
  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsString()
  @MinLength(6)
  @MaxLength(200)
  password: string;
}

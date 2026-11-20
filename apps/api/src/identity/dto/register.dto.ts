import { Transform } from "class-transformer";
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class RegisterDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  displayName?: string;
}

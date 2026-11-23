import { IsString, Matches, MaxLength, MinLength } from "class-validator";

export class RegenerateMfaRecoveryCodesDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  currentCode!: string;
}

import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

export class ConfirmMfaEnrollmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  pendingCode!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  currentCode?: string;
}

import { IsString, Matches, MaxLength, MinLength } from "class-validator";

export class ConfirmPasswordResetDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  token!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(128)
  newPassword!: string;
}

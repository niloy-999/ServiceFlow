import { IsString, MaxLength, MinLength } from "class-validator";

export class StartMfaEnrollmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

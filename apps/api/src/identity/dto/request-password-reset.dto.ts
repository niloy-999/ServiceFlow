import { Transform } from "class-transformer";
import { IsEmail, MaxLength } from "class-validator";

export class RequestPasswordResetDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

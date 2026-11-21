import { IsString, Matches } from "class-validator";

export class VerifyMfaDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  challengeToken!: string;

  @IsString()
  @Matches(/^(?:\d{6}|[A-F0-9]{8}(?:-[A-F0-9]{8}){3})$/)
  code!: string;
}

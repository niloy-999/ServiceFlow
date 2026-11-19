import { Module } from "@nestjs/common";
import { PasswordService } from "./password.service.js";
import { SessionService } from "./session.service.js";

@Module({
  providers: [PasswordService, SessionService],
  exports: [PasswordService, SessionService],
})
export class IdentityModule {}

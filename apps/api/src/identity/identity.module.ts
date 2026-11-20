import { Module } from "@nestjs/common";

import { RateLimitModule } from "../rate-limit/rate-limit.module.js";

import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { CsrfService } from "./csrf.service.js";
import { EmailDeliveryService } from "./email-delivery.service.js";
import { PasswordService } from "./password.service.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import { SessionService } from "./session.service.js";

@Module({
  imports: [RateLimitModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    CsrfService,
    EmailDeliveryService,
    PasswordService,
    SessionAuthGuard,
    SessionService,
  ],
  exports: [
    AuthService,
    CsrfService,
    EmailDeliveryService,
    PasswordService,
    SessionAuthGuard,
    SessionService,
  ],
})
export class IdentityModule {}

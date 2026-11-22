import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module.js";
import { RateLimitModule } from "../rate-limit/rate-limit.module.js";

import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { CsrfService } from "./csrf.service.js";
import { EmailDeliveryService } from "./email-delivery.service.js";
import { MembershipService } from "./membership.service.js";
import { MfaCryptoService } from "./mfa-crypto.service.js";
import { MfaChallengeService } from "./mfa-challenge.service.js";
import { MfaEnrollmentService } from "./mfa-enrollment.service.js";
import { PasswordService } from "./password.service.js";
import { SessionAuthGuard } from "./session-auth.guard.js";
import { SessionService } from "./session.service.js";

@Module({
  imports: [AuditModule, RateLimitModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    CsrfService,
    EmailDeliveryService,
    MembershipService,
    MfaCryptoService,
    MfaChallengeService,
    MfaEnrollmentService,
    PasswordService,
    SessionAuthGuard,
    SessionService,
  ],
  exports: [
    AuthService,
    CsrfService,
    EmailDeliveryService,
    MembershipService,
    MfaCryptoService,
    MfaChallengeService,
    MfaEnrollmentService,
    PasswordService,
    SessionAuthGuard,
    SessionService,
  ],
})
export class IdentityModule {}

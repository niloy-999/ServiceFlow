import { Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { EmailDeliveryService } from "./email-delivery.service.js";
import { PasswordService } from "./password.service.js";
import { SessionService } from "./session.service.js";
import { RateLimitModule } from "../rate-limit/rate-limit.module.js";

@Module({
  imports: [RateLimitModule],
  controllers: [AuthController],
  providers: [AuthService, EmailDeliveryService, PasswordService, SessionService],
  exports: [AuthService, EmailDeliveryService, PasswordService, SessionService],
})
export class IdentityModule {}

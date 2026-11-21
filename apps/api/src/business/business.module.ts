import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";

import { IdentityModule } from "../identity/identity.module.js";
import { BusinessRegistrationController } from "./business-registration.controller.js";
import { BusinessRegistrationService } from "./business-registration.service.js";

@Module({
  imports: [IdentityModule, AuditModule],
  controllers: [BusinessRegistrationController],
  providers: [BusinessRegistrationService],
})
export class BusinessModule {}

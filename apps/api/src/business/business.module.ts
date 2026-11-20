import { Module } from "@nestjs/common";

import { IdentityModule } from "../identity/identity.module.js";
import { BusinessRegistrationController } from "./business-registration.controller.js";
import { BusinessRegistrationService } from "./business-registration.service.js";

@Module({
  imports: [IdentityModule],
  controllers: [BusinessRegistrationController],
  providers: [BusinessRegistrationService],
})
export class BusinessModule {}

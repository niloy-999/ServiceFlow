import { Module } from "@nestjs/common";
import { BusinessModule } from "./business/business.module.js";
import { PrismaModule } from "./database/prisma.module.js";
import { HealthModule } from "./health/health.module.js";
import { IdentityModule } from "./identity/identity.module.js";

@Module({
  imports: [PrismaModule, HealthModule, IdentityModule, BusinessModule],
})
export class AppModule {}

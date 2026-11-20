import { Module } from "@nestjs/common";
import { PrismaModule } from "./database/prisma.module.js";
import { HealthModule } from "./health/health.module.js";
import { IdentityModule } from "./identity/identity.module.js";

@Module({
  imports: [PrismaModule, HealthModule, IdentityModule],
})
export class AppModule {}

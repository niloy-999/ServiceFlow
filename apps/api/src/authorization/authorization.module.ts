import { Module } from "@nestjs/common";
import { PrismaModule } from "../database/prisma.module.js";
import { TenantContextService } from "../database/tenant-context.service.js";
import { AuthorizationService } from "./authorization.service.js";

@Module({
  imports: [PrismaModule],
  providers: [TenantContextService, AuthorizationService],
  exports: [AuthorizationService],
})
export class AuthorizationModule {}

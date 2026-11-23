import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";
import { TenantContextService } from "./tenant-context.service.js";

import { GlobalIdentityContextService } from "./global-identity-context.service.js";

@Global()
@Module({
  providers: [PrismaService, TenantContextService, GlobalIdentityContextService],
  exports: [PrismaService, TenantContextService, GlobalIdentityContextService],
})
export class PrismaModule {}

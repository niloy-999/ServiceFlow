import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthorizationModule } from "../authorization/authorization.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { SupplierController } from "./supplier.controller.js";
import { SupplierService } from "./supplier.service.js";

@Module({
  imports: [AuditModule, AuthorizationModule, IdentityModule],
  controllers: [SupplierController],
  providers: [SupplierService],
})
export class SupplierModule {}

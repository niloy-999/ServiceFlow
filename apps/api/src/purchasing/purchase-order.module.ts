import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthorizationModule } from "../authorization/authorization.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { PurchaseOrderController } from "./purchase-order.controller.js";
import { PurchaseOrderService } from "./purchase-order.service.js";

@Module({
  imports: [AuditModule, AuthorizationModule, IdentityModule],
  controllers: [PurchaseOrderController],
  providers: [PurchaseOrderService],
})
export class PurchaseOrderModule {}

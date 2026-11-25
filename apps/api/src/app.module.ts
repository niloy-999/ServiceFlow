import { Module } from "@nestjs/common";
import { BusinessModule } from "./business/business.module.js";
import { PrismaModule } from "./database/prisma.module.js";
import { HealthModule } from "./health/health.module.js";
import { IdentityModule } from "./identity/identity.module.js";
import { AuthorizationModule } from "./authorization/authorization.module.js";
import { CatalogueModule } from "./catalogue/catalogue.module.js";
import { InventoryModule } from "./inventory/inventory.module.js";
import { SupplierModule } from "./suppliers/supplier.module.js";
import { PurchaseOrderModule } from "./purchasing/purchase-order.module.js";

@Module({
  imports: [
    PrismaModule,
    HealthModule,
    IdentityModule,
    AuthorizationModule,
    BusinessModule,
    CatalogueModule,
    InventoryModule,
    SupplierModule,
    PurchaseOrderModule,
  ],
})
export class AppModule {}

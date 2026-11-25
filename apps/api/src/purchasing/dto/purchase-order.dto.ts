import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class PurchaseOrderTenantDto {
  @IsUUID()
  tenantId!: string;
}

export class PurchaseOrderBranchDto extends PurchaseOrderTenantDto {
  @IsUUID()
  branchId!: string;
}

export class CreatePurchaseOrderDto extends PurchaseOrderBranchDto {
  @IsUUID()
  supplierId!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class PurchaseOrderVersionDto extends PurchaseOrderTenantDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}

export class PurchaseOrderListQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(DRAFT|PENDING_APPROVAL|WITHDRAWN|APPROVED|PARTIALLY_RECEIVED|RECEIVED|CANCELLED)$/)
  status?: string;
}

export class PurchaseOrderListDto extends PurchaseOrderTenantDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^(DRAFT|PENDING_APPROVAL|WITHDRAWN|APPROVED|PARTIALLY_RECEIVED|RECEIVED|CANCELLED)$/)
  status?: string;
}

export class PurchaseOrderReasonDto extends PurchaseOrderVersionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(/\S/, { message: "A nonblank reason is required." })
  reason!: string;
}

export class PurchaseOrderLifecycleDto extends PurchaseOrderBranchDto {
  @IsUUID()
  purchaseOrderId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}

export class PurchaseOrderLifecycleReasonDto extends PurchaseOrderLifecycleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @Matches(/\S/, { message: "A nonblank reason is required." })
  reason!: string;
}

export class PurchaseOrderCancellationDecisionDto extends PurchaseOrderLifecycleDto {
  @IsUUID()
  cancellationRequestId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  requestVersion!: number;

  @IsString()
  @Matches(/^(APPROVED|REJECTED)$/)
  decision!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  @Matches(/\S/)
  reason?: string;
}

export class PurchaseOrderLineListDto extends PurchaseOrderTenantDto {
  @IsUUID()
  branchId!: string;

  @IsUUID()
  purchaseOrderId!: string;
}

export class CreatePurchaseOrderLineDto extends PurchaseOrderLineListDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;

  @IsUUID()
  productId!: string;

  @IsUUID()
  variantId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  orderedQuantity!: number;

  @IsString()
  @Matches(/^(0|[1-9]\d{0,18})$/)
  unitCostMinor!: string;
}

export class UpdatePurchaseOrderLineDto extends PurchaseOrderLineListDto {
  @IsUUID()
  lineId!: string;

  @IsInt()
  @Min(1)
  @Max(2147483647)
  orderedQuantity!: number;

  @IsString()
  @Matches(/^(0|[1-9]\d{0,18})$/)
  unitCostMinor!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}

export class DeletePurchaseOrderLineDto extends PurchaseOrderLineListDto {
  @IsUUID()
  lineId!: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}

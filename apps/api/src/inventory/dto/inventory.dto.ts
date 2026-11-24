import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  NotEquals,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

export class InventoryTenantDto {
  @IsUUID()
  tenantId!: string;
}

export class SubmitInventoryAdjustmentDto extends InventoryTenantDto {
  @IsUUID()
  branchId!: string;

  @IsUUID()
  productId!: string;

  @IsUUID()
  variantId!: string;

  @IsInt()
  @NotEquals(0)
  @Min(-1000000)
  @Max(1000000)
  quantityDelta!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(160)
  idempotencyKey!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => InventorySerialChangeDto)
  serialChanges?: InventorySerialChangeDto[];
}

export class InventorySerialChangeDto {
  @IsIn(["ADD", "REMOVE"])
  action!: "ADD" | "REMOVE";

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  serial!: string;
}

export class DecideInventoryAdjustmentDto extends InventoryTenantDto {
  @IsUUID()
  branchId!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(160)
  idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  decisionReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  negativeStockReason?: string;
}

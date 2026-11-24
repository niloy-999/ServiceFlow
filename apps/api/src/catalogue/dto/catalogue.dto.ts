import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

const PRODUCT_KINDS = ["RETAIL", "REPAIR_PART", "BOTH"] as const;
const IDENTIFIER_TYPES = ["BARCODE", "ALTERNATE"] as const;

export class CatalogueTenantDto {
  @IsUUID()
  tenantId!: string;
}

export class CreateCategoryDto extends CatalogueTenantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class UpdateCategoryDto extends CatalogueTenantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class CreateBrandDto extends CatalogueTenantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class UpdateBrandDto extends CatalogueTenantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

export class ProductIdentifierDto {
  @IsIn(IDENTIFIER_TYPES)
  type!: (typeof IDENTIFIER_TYPES)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  value!: string;
}

export class ProductVariantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  variantCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(180)
  name!: string;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  priceMinor?: number;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ProductIdentifierDto)
  identifiers?: ProductIdentifierDto[];
}

export class AddProductVariantDto extends ProductVariantDto {
  @IsUUID()
  tenantId!: string;
}

export class CreateProductDto extends CatalogueTenantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  productCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(180)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsIn(PRODUCT_KINDS)
  productKind!: (typeof PRODUCT_KINDS)[number];

  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsUUID()
  brandId?: string | null;

  @IsOptional()
  @IsBoolean()
  trackSerials?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProductVariantDto)
  variants?: ProductVariantDto[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  priceMinor?: number;
}

export class UpdateProductDto extends CatalogueTenantDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(180)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @IsIn(PRODUCT_KINDS)
  productKind!: (typeof PRODUCT_KINDS)[number];

  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @IsOptional()
  @IsUUID()
  brandId?: string | null;

  @IsBoolean()
  trackSerials!: boolean;
}

export class UpdateVariantDto extends CatalogueTenantDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(180)
  name!: string;

  @IsObject()
  attributes!: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  priceMinor?: number;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(3)
  currency?: string;
}

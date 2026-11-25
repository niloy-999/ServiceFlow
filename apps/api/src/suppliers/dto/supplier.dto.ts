import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";

export class SupplierTenantDto {
  @IsUUID()
  tenantId!: string;
}

export class SupplierVersionDto extends SupplierTenantDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  version!: number;
}

export class CreateSupplierDto extends SupplierTenantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/\S/, { message: "Supplier name cannot be blank." })
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactName?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class UpdateSupplierDto extends SupplierVersionDto {
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(/\S/, { message: "Supplier name cannot be blank." })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactName?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

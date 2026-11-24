import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Prisma } from "../generated/prisma/client.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthorizationService } from "../authorization/authorization.service.js";
import type {
  AddProductVariantDto,
  CreateBrandDto,
  CreateCategoryDto,
  CreateProductDto,
  ProductVariantDto,
  UpdateBrandDto,
  UpdateCategoryDto,
  UpdateProductDto,
  UpdateVariantDto,
} from "./dto/catalogue.dto.js";

type CatalogueTransaction = Prisma.TransactionClient;
type VariantInput = ProductVariantDto & { isDefault: boolean };
export interface ProductRecord {
  id: string;
  productCode: string;
  name: string;
  description: string | null;
  productKind: string;
  categoryId: string | null;
  categoryName: string | null;
  brandId: string | null;
  brandName: string | null;
  trackSerials: boolean;
  status: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
  variants: {
    id: string;
    variantCode: string;
    sku: string;
    name: string;
    attributes: Record<string, unknown>;
    isDefault: boolean;
    status: string;
    version: string;
    priceMinor: string | null;
    currency: string | null;
  }[];
}

function normalized(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase();
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  if (!slug) throw new BadRequestException("The name must contain letters or numbers.");
  return slug;
}

function dbConflict(error: unknown): never {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: string }).code === "P2002" ||
      ((error as { code?: string }).code === "P2010" &&
        "message" in error &&
        typeof error.message === "string" &&
        error.message.includes("Code: `23505`")))
  ) {
    throw new ConflictException("A catalogue code or identifier already exists.");
  }
  throw error;
}

@Injectable()
export class CatalogueService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  private async run<T>(
    userId: string,
    tenantId: string,
    permission: "catalogue.read" | "catalogue.manage",
    operation: "VIEW" | "OPERATE",
    callback: (tx: CatalogueTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.authorization.withPermission({
        userId,
        tenantId,
        permission,
        operation,
        callback,
      });
    } catch (error) {
      dbConflict(error);
    }
  }

  async listCategories(userId: string, tenantId: string) {
    return this.run(
      userId,
      tenantId,
      "catalogue.read",
      "VIEW",
      async (tx) =>
        tx.$queryRaw`
        SELECT id, parent_id AS "parentId", name, slug, status, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM categories
        WHERE tenant_id = ${tenantId}::uuid
        ORDER BY name, id
      `,
    );
  }

  async createCategory(userId: string, input: CreateCategoryDto) {
    const id = randomUUID();
    const name = input.name.trim();
    return this.run(userId, input.tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      if (input.parentId) {
        const parent = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM categories WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${input.parentId}::uuid AND status = 'ACTIVE'
        `;
        if (!parent[0]) throw new BadRequestException("The parent category is unavailable.");
      }
      await tx.$executeRaw`
        INSERT INTO categories (id, tenant_id, parent_id, name, slug, status, updated_at)
        VALUES (${id}::uuid, ${input.tenantId}::uuid, ${input.parentId ?? null}::uuid,
          ${name}, ${slugify(name)}, 'ACTIVE', CURRENT_TIMESTAMP)
      `;
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "catalogue.category.created",
        targetType: "category",
        targetId: id,
        outcome: "SUCCESS",
      });
      return { id, name, slug: slugify(name), status: "ACTIVE" };
    });
  }

  async updateCategory(userId: string, categoryId: string, input: UpdateCategoryDto) {
    const name = input.name.trim();
    return this.run(userId, input.tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE categories SET name = ${name}, slug = ${slugify(name)},
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${input.tenantId}::uuid AND id = ${categoryId}::uuid
          AND status = 'ACTIVE'
        RETURNING id
      `;
      if (!updated[0]) throw new NotFoundException("The category is unavailable.");
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "catalogue.category.updated",
        targetType: "category",
        targetId: categoryId,
        outcome: "SUCCESS",
      });
      return { id: categoryId, name, slug: slugify(name), status: "ACTIVE" };
    });
  }

  async archiveCategory(userId: string, categoryId: string, tenantId: string) {
    return this.archiveRecord(userId, tenantId, "categories", categoryId, "category");
  }

  async listBrands(userId: string, tenantId: string) {
    return this.run(
      userId,
      tenantId,
      "catalogue.read",
      "VIEW",
      async (tx) =>
        tx.$queryRaw`
        SELECT id, name, status, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM brands WHERE tenant_id = ${tenantId}::uuid ORDER BY name, id
      `,
    );
  }

  async createBrand(userId: string, input: CreateBrandDto) {
    const id = randomUUID();
    const name = input.name.trim();
    return this.run(userId, input.tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      await tx.$executeRaw`
        INSERT INTO brands (id, tenant_id, name, name_normalized, status, updated_at)
        VALUES (${id}::uuid, ${input.tenantId}::uuid, ${name}, ${normalized(name)}, 'ACTIVE', CURRENT_TIMESTAMP)
      `;
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "catalogue.brand.created",
        targetType: "brand",
        targetId: id,
        outcome: "SUCCESS",
      });
      return { id, name, status: "ACTIVE" };
    });
  }

  async updateBrand(userId: string, brandId: string, input: UpdateBrandDto) {
    const name = input.name.trim();
    return this.run(userId, input.tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE brands SET name = ${name}, name_normalized = ${normalized(name)},
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${input.tenantId}::uuid AND id = ${brandId}::uuid
          AND status = 'ACTIVE'
        RETURNING id
      `;
      if (!updated[0]) throw new NotFoundException("The brand is unavailable.");
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "catalogue.brand.updated",
        targetType: "brand",
        targetId: brandId,
        outcome: "SUCCESS",
      });
      return { id: brandId, name, status: "ACTIVE" };
    });
  }

  async archiveBrand(userId: string, brandId: string, tenantId: string) {
    return this.archiveRecord(userId, tenantId, "brands", brandId, "brand");
  }

  async listProducts(userId: string, tenantId: string) {
    return this.run(userId, tenantId, "catalogue.read", "VIEW", (tx) =>
      this.readProducts(tx, tenantId),
    );
  }

  async getProduct(userId: string, tenantId: string, productId: string) {
    return this.run(userId, tenantId, "catalogue.read", "VIEW", async (tx) => {
      const products = await this.readProducts(tx, tenantId, productId);
      if (!products[0]) throw new NotFoundException("The product is unavailable.");
      return products[0];
    });
  }

  private readProducts(
    tx: CatalogueTransaction,
    tenantId: string,
    productId?: string,
  ): Promise<ProductRecord[]> {
    return tx.$queryRaw<ProductRecord[]>`
      SELECT p.id, p.product_code AS "productCode", p.name, p.description,
        p.product_kind AS "productKind", p.category_id AS "categoryId",
        c.name AS "categoryName", p.brand_id AS "brandId", b.name AS "brandName",
        p.track_serials AS "trackSerials", p.status, p.version::text AS version,
        p.created_at AS "createdAt", p.updated_at AS "updatedAt",
        COALESCE(jsonb_agg(
          jsonb_build_object(
            'id', v.id, 'variantCode', v.variant_code, 'sku', v.sku,
            'name', v.name, 'attributes', v.attributes, 'isDefault', v.is_default,
            'status', v.status, 'version', v.version::text,
            'priceMinor', current_price.amount_minor::text,
            'currency', current_price.currency
          ) ORDER BY v.is_default DESC, v.sku
        ) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
      FROM products AS p
      LEFT JOIN categories AS c ON c.tenant_id = p.tenant_id AND c.id = p.category_id
      LEFT JOIN brands AS b ON b.tenant_id = p.tenant_id AND b.id = p.brand_id
      LEFT JOIN product_variants AS v ON v.tenant_id = p.tenant_id AND v.product_id = p.id
      LEFT JOIN product_prices AS current_price
        ON current_price.tenant_id = v.tenant_id AND current_price.variant_id = v.id
        AND current_price.valid_to IS NULL
      WHERE p.tenant_id = ${tenantId}::uuid
        AND (${productId ?? null}::uuid IS NULL OR p.id = ${productId ?? null}::uuid)
      GROUP BY p.id, c.name, b.name
      ORDER BY p.created_at DESC, p.id
    `;
  }

  async createProduct(userId: string, input: CreateProductDto) {
    const productId = randomUUID();
    const rawVariants = input.variants ?? [];
    if (rawVariants.length === 0 && !input.sku) {
      throw new BadRequestException(
        "A SKU is required when creating a product without explicit variants.",
      );
    }
    if (rawVariants.length > 0 && input.sku !== undefined) {
      throw new BadRequestException("Put each SKU on its explicit product variant.");
    }
    if (rawVariants.filter((variant) => variant.isDefault).length > 1) {
      throw new BadRequestException("A product can have only one default variant.");
    }
    const variants: VariantInput[] =
      rawVariants.length === 0
        ? [
            {
              variantCode: "DEFAULT",
              sku: input.sku!,
              name: input.name,
              isDefault: true,
              attributes: {},
              identifiers: [],
              ...(input.priceMinor === undefined ? {} : { priceMinor: input.priceMinor }),
            },
          ]
        : rawVariants.map((variant, index) => ({
            ...variant,
            isDefault: rawVariants.some((candidate) => candidate.isDefault)
              ? variant.isDefault === true
              : index === 0,
          }));
    const name = input.name.trim();
    const productCode = normalized(input.productCode);
    return this.run(userId, input.tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      await this.validateReferences(tx, input.tenantId, input.categoryId, input.brandId);
      await tx.$executeRaw`
        INSERT INTO products
          (id, tenant_id, product_code, name, description, product_kind, category_id, brand_id, track_serials, status, updated_at)
        VALUES
          (${productId}::uuid, ${input.tenantId}::uuid, ${productCode}, ${name},
            ${input.description?.trim() || null}, ${input.productKind}::"ProductKind",
            ${input.categoryId ?? null}::uuid, ${input.brandId ?? null}::uuid,
            ${input.trackSerials ?? false}, 'ACTIVE', CURRENT_TIMESTAMP)
      `;
      for (const variant of variants) {
        await this.insertVariant(tx, input.tenantId, productId, variant);
      }
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "catalogue.product.created",
        targetType: "product",
        targetId: productId,
        outcome: "SUCCESS",
      });
      return (await this.readProducts(tx, input.tenantId, productId))[0];
    });
  }

  private async validateReferences(
    tx: CatalogueTransaction,
    tenantId: string,
    categoryId?: string | null,
    brandId?: string | null,
  ) {
    if (categoryId) {
      const category = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM categories WHERE tenant_id = ${tenantId}::uuid
          AND id = ${categoryId}::uuid AND status = 'ACTIVE'
      `;
      if (!category[0]) throw new BadRequestException("The selected category is unavailable.");
    }
    if (brandId) {
      const brand = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM brands WHERE tenant_id = ${tenantId}::uuid
          AND id = ${brandId}::uuid AND status = 'ACTIVE'
      `;
      if (!brand[0]) throw new BadRequestException("The selected brand is unavailable.");
    }
  }

  private async insertVariant(
    tx: CatalogueTransaction,
    tenantId: string,
    productId: string,
    variant: VariantInput,
  ): Promise<string> {
    const variantId = randomUUID();
    const currency = (variant.currency ?? "BDT").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency))
      throw new BadRequestException("A three-letter currency code is required.");
    await tx.$executeRaw`
      INSERT INTO product_variants
        (id, tenant_id, product_id, variant_code, sku, name, attributes, is_default, status, updated_at)
      VALUES (${variantId}::uuid, ${tenantId}::uuid, ${productId}::uuid,
        ${normalized(variant.variantCode)}, ${variant.sku.trim()}, ${variant.name.trim()},
        ${JSON.stringify(variant.attributes ?? {})}::jsonb, ${variant.isDefault}, 'ACTIVE', CURRENT_TIMESTAMP)
    `;
    if (variant.priceMinor !== undefined) {
      await tx.$executeRaw`
        INSERT INTO product_prices (id, tenant_id, product_id, variant_id, currency, amount_minor)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${productId}::uuid,
          ${variantId}::uuid, ${currency}, ${BigInt(variant.priceMinor)})
      `;
    }
    for (const identifier of variant.identifiers ?? []) {
      await tx.$executeRaw`
        INSERT INTO product_identifiers (id, tenant_id, product_id, variant_id, identifier_type, value_normalized)
        VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${productId}::uuid, ${variantId}::uuid,
          ${identifier.type}::"ProductIdentifierType", ${normalized(identifier.value)})
      `;
    }
    return variantId;
  }

  async updateProduct(userId: string, productId: string, input: UpdateProductDto) {
    return this.run(userId, input.tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      await this.validateReferences(tx, input.tenantId, input.categoryId, input.brandId);
      const updated = await tx.$queryRaw<{ id: string }[]>`
        UPDATE products SET
          name = ${input.name.trim()},
          description = CASE
            WHEN ${input.description !== undefined}
              THEN ${input.description?.trim() || null}
            ELSE description
          END,
          product_kind = ${input.productKind}::"ProductKind",
          category_id = CASE
            WHEN ${input.categoryId !== undefined}
              THEN ${input.categoryId ?? null}::uuid
            ELSE category_id
          END,
          brand_id = CASE
            WHEN ${input.brandId !== undefined}
              THEN ${input.brandId ?? null}::uuid
            ELSE brand_id
          END,
          track_serials = ${input.trackSerials},
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
        WHERE tenant_id = ${input.tenantId}::uuid AND id = ${productId}::uuid
          AND status = 'ACTIVE' AND version = ${BigInt(input.version)}
        RETURNING id
      `;
      if (!updated[0])
        throw new ConflictException(
          "The product changed or is no longer active. Reload and try again.",
        );
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "catalogue.product.updated",
        targetType: "product",
        targetId: productId,
        outcome: "SUCCESS",
      });
      return (await this.readProducts(tx, input.tenantId, productId))[0];
    });
  }

  async updateVariant(userId: string, variantId: string, input: UpdateVariantDto) {
    return this.run(userId, input.tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      const changed = await tx.$queryRaw<{ product_id: string }[]>`
        UPDATE product_variants SET sku = ${input.sku.trim()}, name = ${input.name.trim()},
          attributes = ${JSON.stringify(input.attributes)}::jsonb,
          version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${input.tenantId}::uuid AND id = ${variantId}::uuid
          AND status = 'ACTIVE' AND version = ${BigInt(input.version)}
        RETURNING product_id
      `;
      const variant = changed[0];
      if (!variant)
        throw new ConflictException(
          "The variant changed or is no longer active. Reload and try again.",
        );
      if (input.priceMinor !== undefined)
        await this.replaceCurrentPrice(
          tx,
          input.tenantId,
          variant.product_id,
          variantId,
          input.priceMinor,
          input.currency ?? "BDT",
        );
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "catalogue.variant.updated",
        targetType: "product_variant",
        targetId: variantId,
        outcome: "SUCCESS",
      });
      return (await this.readProducts(tx, input.tenantId, variant.product_id))[0];
    });
  }

  async addVariant(userId: string, productId: string, input: AddProductVariantDto) {
    return this.run(userId, input.tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      const products = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM products WHERE tenant_id = ${input.tenantId}::uuid
          AND id = ${productId}::uuid AND status = 'ACTIVE' FOR UPDATE
      `;
      if (!products[0]) throw new NotFoundException("The product is unavailable.");
      const variantInput: VariantInput = {
        ...input,
        isDefault: input.isDefault ?? false,
      };
      if (variantInput.isDefault) {
        await tx.$executeRaw`
          UPDATE product_variants SET is_default = false, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid AND product_id = ${productId}::uuid AND is_default
        `;
      }
      const variantId = await this.insertVariant(tx, input.tenantId, productId, variantInput);
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId: input.tenantId,
        action: "catalogue.variant.created",
        targetType: "product_variant",
        targetId: variantId,
        outcome: "SUCCESS",
      });
      return (await this.readProducts(tx, input.tenantId, productId))[0];
    });
  }

  private async replaceCurrentPrice(
    tx: CatalogueTransaction,
    tenantId: string,
    productId: string,
    variantId: string,
    amountMinor: number,
    currencyInput: string,
  ) {
    const currency = currencyInput.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency))
      throw new BadRequestException("A three-letter currency code is required.");
    const now = new Date();
    await tx.$executeRaw`
      UPDATE product_prices SET valid_to = ${now}
      WHERE tenant_id = ${tenantId}::uuid AND variant_id = ${variantId}::uuid AND valid_to IS NULL
    `;
    await tx.$executeRaw`
      INSERT INTO product_prices (id, tenant_id, product_id, variant_id, currency, amount_minor, valid_from)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${productId}::uuid,
        ${variantId}::uuid, ${currency}, ${BigInt(amountMinor)}, ${now})
    `;
  }

  async makeVariantDefault(userId: string, variantId: string, tenantId: string) {
    return this.run(userId, tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      const candidates = await tx.$queryRaw<{ product_id: string }[]>`
        SELECT product_id FROM product_variants
        WHERE tenant_id = ${tenantId}::uuid AND id = ${variantId}::uuid
      `;
      const candidate = candidates[0];
      if (!candidate) throw new NotFoundException("The variant is unavailable.");

      const products = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM products
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${candidate.product_id}::uuid
          AND status = 'ACTIVE'
        FOR UPDATE
      `;
      if (!products[0]) throw new NotFoundException("The product is unavailable.");

      const variants = await tx.$queryRaw<{ product_id: string }[]>`
        SELECT product_id FROM product_variants
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${variantId}::uuid
          AND product_id = ${candidate.product_id}::uuid
          AND status = 'ACTIVE'
        FOR UPDATE
      `;
      const variant = variants[0];
      if (!variant) throw new NotFoundException("The active variant is unavailable.");

      await tx.$executeRaw`
        UPDATE product_variants SET is_default = false, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${tenantId}::uuid
          AND product_id = ${variant.product_id}::uuid
          AND is_default
      `;
      await tx.$executeRaw`
        UPDATE product_variants SET is_default = true, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${tenantId}::uuid
          AND product_id = ${variant.product_id}::uuid
          AND id = ${variantId}::uuid
      `;
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId,
        action: "catalogue.variant.default_changed",
        targetType: "product_variant",
        targetId: variantId,
        outcome: "SUCCESS",
      });
      return (await this.readProducts(tx, tenantId, variant.product_id))[0];
    });
  }

  async archiveVariant(userId: string, variantId: string, tenantId: string) {
    return this.run(userId, tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      const candidates = await tx.$queryRaw<{ product_id: string }[]>`
        SELECT product_id FROM product_variants
        WHERE tenant_id = ${tenantId}::uuid AND id = ${variantId}::uuid
      `;
      const candidate = candidates[0];
      if (!candidate) throw new NotFoundException("The variant is unavailable.");

      const products = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM products
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${candidate.product_id}::uuid
          AND status = 'ACTIVE'
        FOR UPDATE
      `;
      if (!products[0]) throw new NotFoundException("The product is unavailable.");

      const variants = await tx.$queryRaw<{ id: string; is_default: boolean }[]>`
        SELECT id, is_default FROM product_variants
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${variantId}::uuid
          AND product_id = ${candidate.product_id}::uuid
          AND status = 'ACTIVE'
        FOR UPDATE
      `;
      const variant = variants[0];
      if (!variant) throw new NotFoundException("The active variant is unavailable.");
      if (variant.is_default) {
        throw new ConflictException(
          "A default variant cannot be archived; choose another default first.",
        );
      }

      await tx.$executeRaw`
        UPDATE product_variants
        SET status = 'ARCHIVED', version = version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${variantId}::uuid
          AND status = 'ACTIVE'
          AND NOT is_default
      `;
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId,
        action: "catalogue.variant.archived",
        targetType: "product_variant",
        targetId: variantId,
        outcome: "SUCCESS",
      });
      return { id: variantId, status: "ARCHIVED" };
    });
  }

  async archiveProduct(userId: string, productId: string, tenantId: string) {
    return this.archiveRecord(userId, tenantId, "products", productId, "product");
  }

  private async archiveRecord(
    userId: string,
    tenantId: string,
    table: "categories" | "brands" | "products",
    id: string,
    type: string,
  ) {
    const action = `catalogue.${type}.archived`;
    return this.run(userId, tenantId, "catalogue.manage", "OPERATE", async (tx) => {
      const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "${table}" SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = $1::uuid AND id = $2::uuid AND status = 'ACTIVE'
         RETURNING id`,
        tenantId,
        id,
      );
      if (!rows[0]) throw new NotFoundException(`The ${type} is unavailable.`);
      await this.audit.record(tx, {
        actorUserId: userId,
        tenantId,
        action,
        targetType: type,
        targetId: id,
        outcome: "SUCCESS",
      });
      return { id, status: "ARCHIVED" };
    });
  }
}

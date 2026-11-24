CREATE TYPE "ProductKind" AS ENUM ('RETAIL', 'REPAIR_PART', 'BOTH');
CREATE TYPE "CatalogueStatus" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "ProductIdentifierType" AS ENUM ('BARCODE', 'ALTERNATE');

CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(140) NOT NULL,
    "status" "CatalogueStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "categories_name_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "categories_slug_check" CHECK (length(btrim("slug")) > 0),
    CONSTRAINT "categories_not_self_parent_check" CHECK ("parent_id" IS NULL OR "parent_id" <> "id"),
    CONSTRAINT "categories_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
    CONSTRAINT "categories_tenant_id_slug_key" UNIQUE ("tenant_id", "slug"),
    CONSTRAINT "categories_business_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "categories_parent_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "categories_tenant_parent_status_idx" ON "categories"("tenant_id", "parent_id", "status");

CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "name_normalized" VARCHAR(120) NOT NULL,
    "status" "CatalogueStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "brands_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "brands_name_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "brands_name_normalized_check" CHECK ("name_normalized" = upper(btrim("name_normalized")) AND length(btrim("name_normalized")) > 0),
    CONSTRAINT "brands_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
    CONSTRAINT "brands_tenant_id_name_normalized_key" UNIQUE ("tenant_id", "name_normalized"),
    CONSTRAINT "brands_business_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "brands_tenant_status_name_idx" ON "brands"("tenant_id", "status", "name");

CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "description" VARCHAR(2000),
    "product_kind" "ProductKind" NOT NULL,
    "category_id" UUID,
    "brand_id" UUID,
    "track_serials" BOOLEAN NOT NULL DEFAULT false,
    "status" "CatalogueStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    CONSTRAINT "products_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "products_product_code_check" CHECK (length(btrim("product_code")) > 0),
    CONSTRAINT "products_name_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "products_version_check" CHECK ("version" > 0),
    CONSTRAINT "products_tenant_id_id_key" UNIQUE ("tenant_id", "id"),
    CONSTRAINT "products_tenant_id_product_code_key" UNIQUE ("tenant_id", "product_code"),
    CONSTRAINT "products_business_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "products_category_fkey" FOREIGN KEY ("tenant_id", "category_id") REFERENCES "categories"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "products_brand_fkey" FOREIGN KEY ("tenant_id", "brand_id") REFERENCES "brands"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "products_tenant_status_name_idx" ON "products"("tenant_id", "status", "name");
CREATE INDEX "products_tenant_category_idx" ON "products"("tenant_id", "category_id");
CREATE INDEX "products_tenant_brand_idx" ON "products"("tenant_id", "brand_id");

CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_code" VARCHAR(64) NOT NULL,
    "sku" VARCHAR(100) NOT NULL,
    "name" VARCHAR(180) NOT NULL,
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "CatalogueStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_variants_code_check" CHECK (length(btrim("variant_code")) > 0),
    CONSTRAINT "product_variants_sku_check" CHECK (length(btrim("sku")) > 0),
    CONSTRAINT "product_variants_name_check" CHECK (length(btrim("name")) > 0),
    CONSTRAINT "product_variants_attributes_object_check" CHECK (jsonb_typeof("attributes") = 'object'),
    CONSTRAINT "product_variants_version_check" CHECK ("version" > 0),
    CONSTRAINT "product_variants_tenant_product_id_id_key" UNIQUE ("tenant_id", "product_id", "id"),
    CONSTRAINT "product_variants_tenant_product_code_key" UNIQUE ("tenant_id", "product_id", "variant_code"),
    CONSTRAINT "product_variants_product_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "product_variants_default_unique" ON "product_variants"("tenant_id", "product_id") WHERE "is_default";
CREATE UNIQUE INDEX "product_variants_tenant_sku_normalized_unique" ON "product_variants"("tenant_id", upper(btrim("sku")));
CREATE INDEX "product_variants_tenant_product_status_idx" ON "product_variants"("tenant_id", "product_id", "status");

CREATE TABLE "product_identifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "identifier_type" "ProductIdentifierType" NOT NULL,
    "value_normalized" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_identifiers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_identifiers_value_check" CHECK ("value_normalized" = upper(btrim("value_normalized")) AND length(btrim("value_normalized")) > 0),
    CONSTRAINT "product_identifiers_product_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "product_identifiers_variant_fkey" FOREIGN KEY ("tenant_id", "product_id", "variant_id") REFERENCES "product_variants"("tenant_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "product_identifiers_tenant_type_value_key" ON "product_identifiers"("tenant_id", "identifier_type", "value_normalized");
CREATE UNIQUE INDEX "product_identifiers_tenant_id_id_key" ON "product_identifiers"("tenant_id", "id");
CREATE INDEX "product_identifiers_tenant_variant_idx" ON "product_identifiers"("tenant_id", "variant_id");

CREATE TABLE "product_prices" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "valid_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_to" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_prices_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_prices_amount_check" CHECK ("amount_minor" >= 0),
    CONSTRAINT "product_prices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "product_prices_period_check" CHECK ("valid_to" IS NULL OR "valid_to" > "valid_from"),
    CONSTRAINT "product_prices_product_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "product_prices_variant_fkey" FOREIGN KEY ("tenant_id", "product_id", "variant_id") REFERENCES "product_variants"("tenant_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "product_prices_one_current_variant_price" ON "product_prices"("tenant_id", "variant_id") WHERE "valid_to" IS NULL;
CREATE INDEX "product_prices_tenant_variant_valid_from_idx" ON "product_prices"("tenant_id", "variant_id", "valid_from");

-- A product is not committed without exactly one active canonical default variant.
CREATE FUNCTION public.check_product_default_variant()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_tenant_id UUID;
    v_product_id UUID;
    v_default_count BIGINT;
BEGIN
    IF TG_TABLE_NAME = 'products' THEN
        v_tenant_id := NEW.tenant_id;
        v_product_id := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        v_tenant_id := OLD.tenant_id;
        v_product_id := OLD.product_id;
    ELSE
        v_tenant_id := NEW.tenant_id;
        v_product_id := NEW.product_id;
    END IF;

    IF EXISTS (SELECT 1 FROM public.products WHERE tenant_id = v_tenant_id AND id = v_product_id) THEN
        SELECT count(*) INTO v_default_count
        FROM public.product_variants
        WHERE tenant_id = v_tenant_id AND product_id = v_product_id
          AND is_default AND status = 'ACTIVE';
        IF v_default_count <> 1 THEN
            RAISE EXCEPTION 'Every product must have exactly one active default variant.'
                USING ERRCODE = '23514', CONSTRAINT = 'products_default_variant_check';
        END IF;
    END IF;
    RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "products_default_variant_check"
    AFTER INSERT ON "products"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.check_product_default_variant();
CREATE CONSTRAINT TRIGGER "product_variants_default_variant_check"
    AFTER INSERT OR UPDATE OR DELETE ON "product_variants"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION public.check_product_default_variant();

ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_identifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_prices" ENABLE ROW LEVEL SECURITY;

DO $policies$
DECLARE
    v_table TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY['categories', 'brands', 'products', 'product_variants', 'product_identifiers', 'product_prices'] LOOP
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I FOR ALL TO serviceflow_app USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
            v_table
        );
    END LOOP;
END;
$policies$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    "categories", "brands", "products", "product_variants", "product_identifiers", "product_prices"
TO serviceflow_app;

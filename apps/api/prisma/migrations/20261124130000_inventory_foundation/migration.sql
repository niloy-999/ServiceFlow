-- CreateEnum
CREATE TYPE "InventoryOperationType" AS ENUM ('ADJUSTMENT_SUBMIT', 'ADJUSTMENT_APPROVE', 'ADJUSTMENT_REJECT');

-- CreateEnum
CREATE TYPE "InventoryAdjustmentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "InventorySerialUnitStatus" AS ENUM ('IN_STOCK', 'REMOVED');

-- CreateTable
CREATE TABLE "inventory_balances" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "physical_quantity" INTEGER NOT NULL DEFAULT 0,
    "reserved_quantity" INTEGER NOT NULL DEFAULT 0,
    "in_transit_quantity" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "inventory_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_operations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operation_type" "InventoryOperationType" NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "target_id" UUID,
    "result" JSONB,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_adjustments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "requested_by" UUID NOT NULL,
    "submission_operation_id" UUID NOT NULL,
    "quantity_delta" INTEGER NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "serial_changes" JSONB NOT NULL DEFAULT '[]',
    "status" "InventoryAdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by" UUID,
    "decision_reason" VARCHAR(500),
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "decision_operation_id" UUID,

    CONSTRAINT "inventory_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_ledger_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "adjustment_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "quantity_delta" INTEGER NOT NULL,
    "balance_after" INTEGER NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_serial_units" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "serial_normalized" VARCHAR(160) NOT NULL,
    "status" "InventorySerialUnitStatus" NOT NULL DEFAULT 'IN_STOCK',
    "added_by_adjustment_id" UUID NOT NULL,
    "removed_by_adjustment_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_serial_units_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_balances_tenant_id_product_id_branch_id_idx" ON "inventory_balances"("tenant_id", "product_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_tenant_id_branch_id_variant_id_key" ON "inventory_balances"("tenant_id", "branch_id", "variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_balances_tenant_id_id_key" ON "inventory_balances"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "inventory_operations_tenant_id_target_id_operation_type_idx" ON "inventory_operations"("tenant_id", "target_id", "operation_type");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_operations_tenant_id_idempotency_key_key" ON "inventory_operations"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_operations_tenant_id_id_key" ON "inventory_operations"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_adjustments_submission_operation_id_key" ON "inventory_adjustments"("submission_operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_adjustments_decision_operation_id_key" ON "inventory_adjustments"("decision_operation_id");

-- CreateIndex
CREATE INDEX "inventory_adjustments_tenant_id_branch_id_status_created_at_idx" ON "inventory_adjustments"("tenant_id", "branch_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "inventory_adjustments_tenant_id_variant_id_created_at_idx" ON "inventory_adjustments"("tenant_id", "variant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_adjustments_tenant_id_id_key" ON "inventory_adjustments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_ledger_entries_adjustment_id_key" ON "inventory_ledger_entries"("adjustment_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_ledger_entries_operation_id_key" ON "inventory_ledger_entries"("operation_id");

-- CreateIndex
CREATE INDEX "inventory_ledger_entries_tenant_id_variant_id_branch_id_cre_idx" ON "inventory_ledger_entries"("tenant_id", "variant_id", "branch_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_ledger_entries_tenant_id_adjustment_id_idx" ON "inventory_ledger_entries"("tenant_id", "adjustment_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_ledger_entries_tenant_id_id_key" ON "inventory_ledger_entries"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_ledger_entries_tenant_id_adjustment_id_key" ON "inventory_ledger_entries"("tenant_id", "adjustment_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_ledger_entries_tenant_id_operation_id_key" ON "inventory_ledger_entries"("tenant_id", "operation_id");

-- CreateIndex
CREATE INDEX "inventory_serial_units_tenant_id_branch_id_variant_id_statu_idx" ON "inventory_serial_units"("tenant_id", "branch_id", "variant_id", "status");

-- CreateIndex
CREATE INDEX "inventory_serial_units_tenant_id_added_by_adjustment_id_idx" ON "inventory_serial_units"("tenant_id", "added_by_adjustment_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_serial_units_tenant_id_variant_id_serial_normaliz_key" ON "inventory_serial_units"("tenant_id", "variant_id", "serial_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_serial_units_tenant_id_id_key" ON "inventory_serial_units"("tenant_id", "id");

-- RenameForeignKey
ALTER TABLE "brands" RENAME CONSTRAINT "brands_business_fkey" TO "brands_tenant_id_fkey";

-- RenameForeignKey
ALTER TABLE "categories" RENAME CONSTRAINT "categories_business_fkey" TO "categories_tenant_id_fkey";

-- RenameForeignKey
ALTER TABLE "categories" RENAME CONSTRAINT "categories_parent_fkey" TO "categories_tenant_id_parent_id_fkey";

-- RenameForeignKey
ALTER TABLE "membership_branch_scopes" RENAME CONSTRAINT "membership_branch_scopes_branch_fkey" TO "membership_branch_scopes_tenant_id_branch_id_fkey";

-- RenameForeignKey
ALTER TABLE "membership_branch_scopes" RENAME CONSTRAINT "membership_branch_scopes_membership_fkey" TO "membership_branch_scopes_tenant_id_membership_id_fkey";

-- RenameForeignKey
ALTER TABLE "product_identifiers" RENAME CONSTRAINT "product_identifiers_product_fkey" TO "product_identifiers_tenant_id_product_id_fkey";

-- RenameForeignKey
ALTER TABLE "product_identifiers" RENAME CONSTRAINT "product_identifiers_variant_fkey" TO "product_identifiers_tenant_id_product_id_variant_id_fkey";

-- RenameForeignKey
ALTER TABLE "product_prices" RENAME CONSTRAINT "product_prices_product_fkey" TO "product_prices_tenant_id_product_id_fkey";

-- RenameForeignKey
ALTER TABLE "product_prices" RENAME CONSTRAINT "product_prices_variant_fkey" TO "product_prices_tenant_id_product_id_variant_id_fkey";

-- RenameForeignKey
ALTER TABLE "product_variants" RENAME CONSTRAINT "product_variants_product_fkey" TO "product_variants_tenant_id_product_id_fkey";

-- RenameForeignKey
ALTER TABLE "products" RENAME CONSTRAINT "products_brand_fkey" TO "products_tenant_id_brand_id_fkey";

-- RenameForeignKey
ALTER TABLE "products" RENAME CONSTRAINT "products_business_fkey" TO "products_tenant_id_fkey";

-- RenameForeignKey
ALTER TABLE "products" RENAME CONSTRAINT "products_category_fkey" TO "products_tenant_id_category_id_fkey";

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_tenant_id_product_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "product_id", "variant_id") REFERENCES "product_variants"("tenant_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_operations" ADD CONSTRAINT "inventory_operations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_operations" ADD CONSTRAINT "inventory_operations_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_tenant_id_product_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "product_id", "variant_id") REFERENCES "product_variants"("tenant_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_tenant_id_submission_operation_id_fkey" FOREIGN KEY ("tenant_id", "submission_operation_id") REFERENCES "inventory_operations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_adjustments" ADD CONSTRAINT "inventory_adjustments_tenant_id_decision_operation_id_fkey" FOREIGN KEY ("tenant_id", "decision_operation_id") REFERENCES "inventory_operations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_tenant_id_product_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "product_id", "variant_id") REFERENCES "product_variants"("tenant_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_tenant_id_adjustment_id_fkey" FOREIGN KEY ("tenant_id", "adjustment_id") REFERENCES "inventory_adjustments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_tenant_id_operation_id_fkey" FOREIGN KEY ("tenant_id", "operation_id") REFERENCES "inventory_operations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_ledger_entries" ADD CONSTRAINT "inventory_ledger_entries_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_serial_units" ADD CONSTRAINT "inventory_serial_units_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_serial_units" ADD CONSTRAINT "inventory_serial_units_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_serial_units" ADD CONSTRAINT "inventory_serial_units_tenant_id_product_id_fkey" FOREIGN KEY ("tenant_id", "product_id") REFERENCES "products"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_serial_units" ADD CONSTRAINT "inventory_serial_units_tenant_id_product_id_variant_id_fkey" FOREIGN KEY ("tenant_id", "product_id", "variant_id") REFERENCES "product_variants"("tenant_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_serial_units" ADD CONSTRAINT "inventory_serial_units_tenant_id_added_by_adjustment_id_fkey" FOREIGN KEY ("tenant_id", "added_by_adjustment_id") REFERENCES "inventory_adjustments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_serial_units" ADD CONSTRAINT "inventory_serial_units_tenant_id_removed_by_adjustment_id_fkey" FOREIGN KEY ("tenant_id", "removed_by_adjustment_id") REFERENCES "inventory_adjustments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "brands_tenant_status_name_idx" RENAME TO "brands_tenant_id_status_name_idx";

-- RenameIndex
ALTER INDEX "categories_tenant_parent_status_idx" RENAME TO "categories_tenant_id_parent_id_status_idx";

-- RenameIndex
ALTER INDEX "membership_branch_scopes_membership_idx" RENAME TO "membership_branch_scopes_tenant_id_membership_id_idx";

-- RenameIndex
ALTER INDEX "product_identifiers_tenant_type_value_key" RENAME TO "product_identifiers_tenant_id_identifier_type_value_normali_key";

-- RenameIndex
ALTER INDEX "product_identifiers_tenant_variant_idx" RENAME TO "product_identifiers_tenant_id_variant_id_idx";

-- RenameIndex
ALTER INDEX "product_prices_tenant_variant_valid_from_idx" RENAME TO "product_prices_tenant_id_variant_id_valid_from_idx";

-- RenameIndex
ALTER INDEX "product_variants_tenant_product_code_key" RENAME TO "product_variants_tenant_id_product_id_variant_code_key";

-- RenameIndex
ALTER INDEX "product_variants_tenant_product_id_id_key" RENAME TO "product_variants_tenant_id_product_id_id_key";

-- RenameIndex
ALTER INDEX "product_variants_tenant_product_status_idx" RENAME TO "product_variants_tenant_id_product_id_status_idx";

-- RenameIndex
ALTER INDEX "products_tenant_brand_idx" RENAME TO "products_tenant_id_brand_id_idx";

-- RenameIndex
ALTER INDEX "products_tenant_category_idx" RENAME TO "products_tenant_id_category_id_idx";

-- RenameIndex
ALTER INDEX "products_tenant_status_name_idx" RENAME TO "products_tenant_id_status_name_idx";


-- Inventory quantities and versioning.
ALTER TABLE "inventory_balances"
    ADD CONSTRAINT "inventory_balances_reserved_nonnegative_check"
        CHECK ("reserved_quantity" >= 0),
    ADD CONSTRAINT "inventory_balances_in_transit_nonnegative_check"
        CHECK ("in_transit_quantity" >= 0),
    ADD CONSTRAINT "inventory_balances_version_positive_check"
        CHECK ("version" > 0);

-- Idempotent operation metadata.
ALTER TABLE "inventory_operations"
    ADD CONSTRAINT "inventory_operations_idempotency_key_not_blank_check"
        CHECK (length(btrim("idempotency_key")) > 0),
    ADD CONSTRAINT "inventory_operations_request_hash_format_check"
        CHECK ("request_hash" ~ '^[0-9a-fA-F]{64}$'),
    ADD CONSTRAINT "inventory_operations_completion_consistency_check"
        CHECK (
            ("completed_at" IS NULL AND "result" IS NULL)
            OR
            ("completed_at" IS NOT NULL AND "result" IS NOT NULL)
        );

-- Adjustment requests must contain a meaningful, immutable proposal.
ALTER TABLE "inventory_adjustments"
    ADD CONSTRAINT "inventory_adjustments_nonzero_delta_check"
        CHECK ("quantity_delta" <> 0),
    ADD CONSTRAINT "inventory_adjustments_reason_not_blank_check"
        CHECK (length(btrim("reason")) > 0),
    ADD CONSTRAINT "inventory_adjustments_serial_changes_array_check"
        CHECK (jsonb_typeof("serial_changes") = 'array'),
    ADD CONSTRAINT "inventory_adjustments_not_self_decided_check"
        CHECK ("decided_by" IS NULL OR "decided_by" <> "requested_by"),
    ADD CONSTRAINT "inventory_adjustments_decision_state_check"
        CHECK (
            (
                "status" = 'PENDING'
                AND "decided_by" IS NULL
                AND "decision_reason" IS NULL
                AND "decided_at" IS NULL
                AND "decision_operation_id" IS NULL
            )
            OR
            (
                "status" = 'APPROVED'
                AND "decided_by" IS NOT NULL
                AND "decided_at" IS NOT NULL
                AND "decision_operation_id" IS NOT NULL
            )
            OR
            (
                "status" = 'REJECTED'
                AND "decided_by" IS NOT NULL
                AND "decided_at" IS NOT NULL
                AND "decision_operation_id" IS NOT NULL
                AND "decision_reason" IS NOT NULL
                AND length(btrim("decision_reason")) > 0
            )
        );

-- Ledger entries are nonzero historical stock movements.
ALTER TABLE "inventory_ledger_entries"
    ADD CONSTRAINT "inventory_ledger_entries_nonzero_delta_check"
        CHECK ("quantity_delta" <> 0);

-- Serial identifiers are stored in canonical form.
ALTER TABLE "inventory_serial_units"
    ADD CONSTRAINT "inventory_serial_units_serial_not_blank_check"
        CHECK (length(btrim("serial_normalized")) > 0),
    ADD CONSTRAINT "inventory_serial_units_serial_canonical_check"
        CHECK ("serial_normalized" = upper(btrim("serial_normalized"))),
    ADD CONSTRAINT "inventory_serial_units_status_consistency_check"
        CHECK (
            ("status" = 'IN_STOCK' AND "removed_by_adjustment_id" IS NULL)
            OR
            ("status" = 'REMOVED' AND "removed_by_adjustment_id" IS NOT NULL)
        );


-- Tenant isolation for all inventory records.
ALTER TABLE "inventory_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_adjustments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_serial_units" ENABLE ROW LEVEL SECURITY;

-- Balances: tenant-scoped reads and controlled writes.
CREATE POLICY "inventory_balances_tenant_select"
    ON "inventory_balances" FOR SELECT TO serviceflow_app
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "inventory_balances_tenant_insert"
    ON "inventory_balances" FOR INSERT TO serviceflow_app
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "inventory_balances_tenant_update"
    ON "inventory_balances" FOR UPDATE TO serviceflow_app
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Operations: the initiating actor owns the operation record.
CREATE POLICY "inventory_operations_tenant_select"
    ON "inventory_operations" FOR SELECT TO serviceflow_app
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "inventory_operations_actor_insert"
    ON "inventory_operations" FOR INSERT TO serviceflow_app
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND "actor_user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

CREATE POLICY "inventory_operations_actor_update"
    ON "inventory_operations" FOR UPDATE TO serviceflow_app
    USING (
        "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND "actor_user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND "actor_user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

-- Adjustment requests: submitter creates; a different actor decides.
CREATE POLICY "inventory_adjustments_tenant_select"
    ON "inventory_adjustments" FOR SELECT TO serviceflow_app
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "inventory_adjustments_requester_insert"
    ON "inventory_adjustments" FOR INSERT TO serviceflow_app
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND "requested_by" = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

CREATE POLICY "inventory_adjustments_decider_update"
    ON "inventory_adjustments" FOR UPDATE TO serviceflow_app
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND "decided_by" = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

-- Ledger: tenant-scoped reads; only the current actor may append.
CREATE POLICY "inventory_ledger_tenant_select"
    ON "inventory_ledger_entries" FOR SELECT TO serviceflow_app
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "inventory_ledger_actor_insert"
    ON "inventory_ledger_entries" FOR INSERT TO serviceflow_app
    WITH CHECK (
        "tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND "actor_user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
    );

-- Serial units: tenant-scoped reads and controlled lifecycle updates.
CREATE POLICY "inventory_serial_units_tenant_select"
    ON "inventory_serial_units" FOR SELECT TO serviceflow_app
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "inventory_serial_units_tenant_insert"
    ON "inventory_serial_units" FOR INSERT TO serviceflow_app
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE POLICY "inventory_serial_units_tenant_update"
    ON "inventory_serial_units" FOR UPDATE TO serviceflow_app
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Remove default broad privileges before granting the minimum required.
REVOKE ALL PRIVILEGES ON TABLE
    "inventory_balances",
    "inventory_operations",
    "inventory_adjustments",
    "inventory_ledger_entries",
    "inventory_serial_units"
FROM serviceflow_app;

GRANT SELECT, INSERT ON TABLE
    "inventory_balances",
    "inventory_operations",
    "inventory_adjustments",
    "inventory_ledger_entries",
    "inventory_serial_units"
TO serviceflow_app;

-- Only mutable projection fields can be updated by the runtime.
GRANT UPDATE (
    "physical_quantity",
    "reserved_quantity",
    "in_transit_quantity",
    "updated_at",
    "version"
) ON TABLE "inventory_balances" TO serviceflow_app;

-- Operation identity and idempotency metadata remain immutable.
GRANT UPDATE ("result", "completed_at")
    ON TABLE "inventory_operations" TO serviceflow_app;

-- Original adjustment proposal fields remain immutable after submission.
GRANT UPDATE (
    "status",
    "decided_by",
    "decision_reason",
    "decided_at",
    "decision_operation_id",
    "updated_at"
) ON TABLE "inventory_adjustments" TO serviceflow_app;

-- Serial identity and origin remain immutable.
GRANT UPDATE (
    "status",
    "removed_by_adjustment_id",
    "updated_at"
) ON TABLE "inventory_serial_units" TO serviceflow_app;

-- The inventory ledger is append-only.
REVOKE UPDATE, DELETE ON TABLE "inventory_ledger_entries"
    FROM serviceflow_app;


-- Recreate the adjustment decision policy explicitly.
DROP POLICY "inventory_adjustments_decider_update"
    ON "inventory_adjustments";

CREATE POLICY "inventory_adjustments_decider_update"
    ON "inventory_adjustments"
    FOR UPDATE TO serviceflow_app
    USING (
        "tenant_id" =
            NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" =
            NULLIF(current_setting('app.tenant_id', true), '')::uuid
        AND "decided_by" =
            NULLIF(current_setting('app.user_id', true), '')::uuid
    );

-- Operation identity is immutable; completion can happen only once.
CREATE FUNCTION public.protect_inventory_operation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Inventory operations cannot be deleted.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
       OR NEW.target_id IS DISTINCT FROM OLD.target_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Inventory operation identity is immutable.'
            USING ERRCODE = '42501';
    END IF;

    IF OLD.completed_at IS NOT NULL
       OR OLD.result IS NOT NULL
       OR NEW.completed_at IS NULL
       OR NEW.result IS NULL THEN
        RAISE EXCEPTION 'An inventory operation can be completed only once.'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "inventory_operations_immutable"
    BEFORE UPDATE OR DELETE ON "inventory_operations"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_inventory_operation();

-- Submitted adjustment proposals are immutable.
-- Only a different actor can make one terminal decision.
CREATE FUNCTION public.protect_inventory_adjustment()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_actor UUID;
    v_operation RECORD;
    v_expected_type "InventoryOperationType";
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Inventory adjustments cannot be deleted.'
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_actor := NULLIF(current_setting('app.user_id', true), '')::uuid;

        IF NEW.requested_by IS DISTINCT FROM v_actor
           OR NEW.status <> 'PENDING'
           OR NEW.decided_by IS NOT NULL
           OR NEW.decided_at IS NOT NULL
           OR NEW.decision_operation_id IS NOT NULL THEN
            RAISE EXCEPTION 'An adjustment must be submitted as a pending request by its requester.'
                USING ERRCODE = '42501';
        END IF;

        SELECT *
          INTO v_operation
          FROM "inventory_operations"
         WHERE "tenant_id" = NEW.tenant_id
           AND "id" = NEW.submission_operation_id;

        IF NOT FOUND
           OR v_operation.operation_type <> 'ADJUSTMENT_SUBMIT'
           OR v_operation.actor_user_id <> NEW.requested_by
           OR v_operation.target_id IS DISTINCT FROM NEW.id THEN
            RAISE EXCEPTION 'Adjustment submission operation does not match the request.'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD.status <> 'PENDING'
       OR NEW.status NOT IN (
           'APPROVED'::"InventoryAdjustmentStatus",
           'REJECTED'::"InventoryAdjustmentStatus"
       ) THEN
        RAISE EXCEPTION 'An adjustment can be decided only once from PENDING.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.submission_operation_id IS DISTINCT FROM OLD.submission_operation_id
       OR NEW.quantity_delta IS DISTINCT FROM OLD.quantity_delta
       OR NEW.reason IS DISTINCT FROM OLD.reason
       OR NEW.serial_changes IS DISTINCT FROM OLD.serial_changes
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'The submitted adjustment proposal is immutable.'
            USING ERRCODE = '42501';
    END IF;

    v_actor := NULLIF(current_setting('app.user_id', true), '')::uuid;

    IF v_actor IS NULL
       OR NEW.decided_by IS DISTINCT FROM v_actor
       OR NEW.decided_by = OLD.requested_by THEN
        RAISE EXCEPTION 'The requester cannot decide their own adjustment.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.decided_at IS NULL
       OR NEW.decision_operation_id IS NULL THEN
        RAISE EXCEPTION 'An adjustment decision requires an operation and timestamp.'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'REJECTED'
       AND (
           NEW.decision_reason IS NULL
           OR length(btrim(NEW.decision_reason)) = 0
       ) THEN
        RAISE EXCEPTION 'Rejecting an adjustment requires a reason.'
            USING ERRCODE = '23514';
    END IF;

    v_expected_type :=
        CASE NEW.status
            WHEN 'APPROVED' THEN 'ADJUSTMENT_APPROVE'::"InventoryOperationType"
            ELSE 'ADJUSTMENT_REJECT'::"InventoryOperationType"
        END;

    SELECT *
      INTO v_operation
      FROM "inventory_operations"
     WHERE "tenant_id" = NEW.tenant_id
       AND "id" = NEW.decision_operation_id;

    IF NOT FOUND
       OR v_operation.operation_type <> v_expected_type
       OR v_operation.actor_user_id <> v_actor
       OR v_operation.target_id IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Adjustment decision operation does not match the decision.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "inventory_adjustments_state_machine"
    BEFORE INSERT OR UPDATE OR DELETE ON "inventory_adjustments"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_inventory_adjustment();


-- Physical stock cannot be negative. Available stock may be negative
-- when reserved quantity exceeds physical quantity under an override.
ALTER TABLE "inventory_balances"
    ADD CONSTRAINT "inventory_balances_physical_nonnegative_check"
    CHECK ("physical_quantity" >= 0);

-- Every ledger movement must be backed by the matching approved adjustment
-- and its approval operation. The balance row must still hold the prior value.
CREATE FUNCTION public.validate_inventory_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_adjustment RECORD;
    v_operation RECORD;
    v_current_quantity INTEGER;
BEGIN
    SELECT *
      INTO v_adjustment
      FROM "inventory_adjustments"
     WHERE "tenant_id" = NEW.tenant_id
       AND "id" = NEW.adjustment_id;

    IF NOT FOUND
       OR v_adjustment.status <> 'APPROVED'
       OR v_adjustment.branch_id <> NEW.branch_id
       OR v_adjustment.product_id <> NEW.product_id
       OR v_adjustment.variant_id <> NEW.variant_id
       OR v_adjustment.quantity_delta <> NEW.quantity_delta
       OR v_adjustment.decided_by <> NEW.actor_user_id
       OR v_adjustment.decision_operation_id <> NEW.operation_id THEN
        RAISE EXCEPTION 'Ledger entry does not match an approved adjustment.'
            USING ERRCODE = '23514';
    END IF;

    SELECT *
      INTO v_operation
      FROM "inventory_operations"
     WHERE "tenant_id" = NEW.tenant_id
       AND "id" = NEW.operation_id;

    IF NOT FOUND
       OR v_operation.operation_type <> 'ADJUSTMENT_APPROVE'
       OR v_operation.actor_user_id <> NEW.actor_user_id
       OR v_operation.target_id IS DISTINCT FROM NEW.adjustment_id
       OR NEW.actor_user_id IS DISTINCT FROM
          NULLIF(current_setting('app.user_id', true), '')::uuid THEN
        RAISE EXCEPTION 'Ledger entry approval operation is invalid.'
            USING ERRCODE = '23514';
    END IF;

    SELECT "physical_quantity"
      INTO v_current_quantity
      FROM "inventory_balances"
     WHERE "tenant_id" = NEW.tenant_id
       AND "branch_id" = NEW.branch_id
       AND "variant_id" = NEW.variant_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'A balance row must exist before posting a ledger entry.'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.balance_after::bigint <>
       v_current_quantity::bigint + NEW.quantity_delta::bigint THEN
        RAISE EXCEPTION 'Ledger balance_after does not match the previous balance and movement.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "inventory_ledger_validate_insert"
    BEFORE INSERT ON "inventory_ledger_entries"
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_inventory_ledger_entry();

-- Ledger history cannot be updated or deleted.
CREATE FUNCTION public.protect_inventory_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'Inventory ledger entries are immutable.'
        USING ERRCODE = '42501';
END;
$function$;

CREATE TRIGGER "inventory_ledger_immutable"
    BEFORE UPDATE OR DELETE ON "inventory_ledger_entries"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_inventory_ledger_entry();

-- A balance row is a durable projection and cannot be deleted.
CREATE FUNCTION public.protect_inventory_balance_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'Inventory balance rows cannot be deleted.'
        USING ERRCODE = '42501';
END;
$function$;

CREATE TRIGGER "inventory_balances_no_delete"
    BEFORE DELETE ON "inventory_balances"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_inventory_balance_delete();

-- At transaction commit, the physical balance must equal the sum of
-- all immutable ledger movements for that tenant, branch and variant.
CREATE FUNCTION public.check_inventory_balance_ledger_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_tenant_id UUID;
    v_branch_id UUID;
    v_variant_id UUID;
    v_physical_quantity BIGINT;
    v_ledger_quantity BIGINT;
BEGIN
    v_tenant_id := NEW.tenant_id;
    v_branch_id := NEW.branch_id;
    v_variant_id := NEW.variant_id;

    SELECT "physical_quantity"::bigint
      INTO v_physical_quantity
      FROM "inventory_balances"
     WHERE "tenant_id" = v_tenant_id
       AND "branch_id" = v_branch_id
       AND "variant_id" = v_variant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Inventory balance disappeared during reconciliation.'
            USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(SUM("quantity_delta"::bigint), 0)
      INTO v_ledger_quantity
      FROM "inventory_ledger_entries"
     WHERE "tenant_id" = v_tenant_id
       AND "branch_id" = v_branch_id
       AND "variant_id" = v_variant_id;

    IF v_physical_quantity <> v_ledger_quantity THEN
        RAISE EXCEPTION
            'Inventory balance (%) does not reconcile with ledger total (%).',
            v_physical_quantity,
            v_ledger_quantity
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "inventory_balances_ledger_reconciliation"
    AFTER INSERT OR UPDATE ON "inventory_balances"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_balance_ledger_reconciliation();

CREATE CONSTRAINT TRIGGER "inventory_ledger_balance_reconciliation"
    AFTER INSERT ON "inventory_ledger_entries"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_balance_ledger_reconciliation();


-- Serial units can only originate from approved positive adjustments.
-- Their identity and origin are immutable; removal requires an approved
-- negative adjustment for the same tenant, branch, product and variant.
CREATE FUNCTION public.protect_inventory_serial_unit()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_adjustment RECORD;
    v_actor UUID;
    v_track_serials BOOLEAN;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Inventory serial units cannot be deleted.'
            USING ERRCODE = '42501';
    END IF;

    v_actor := NULLIF(current_setting('app.user_id', true), '')::uuid;

    IF TG_OP = 'INSERT' THEN
        SELECT "track_serials"
          INTO v_track_serials
          FROM "products"
         WHERE "tenant_id" = NEW.tenant_id
           AND "id" = NEW.product_id;

        IF NOT FOUND OR NOT v_track_serials THEN
            RAISE EXCEPTION 'Serial units require a serial-tracked product.'
                USING ERRCODE = '23514';
        END IF;

        SELECT *
          INTO v_adjustment
          FROM "inventory_adjustments"
         WHERE "tenant_id" = NEW.tenant_id
           AND "id" = NEW.added_by_adjustment_id;

        IF NOT FOUND
           OR v_adjustment.status <> 'APPROVED'
           OR v_adjustment.quantity_delta <= 0
           OR v_adjustment.branch_id <> NEW.branch_id
           OR v_adjustment.product_id <> NEW.product_id
           OR v_adjustment.variant_id <> NEW.variant_id
           OR v_adjustment.decided_by IS DISTINCT FROM v_actor
           OR NEW.status <> 'IN_STOCK'
           OR NEW.removed_by_adjustment_id IS NOT NULL THEN
            RAISE EXCEPTION 'Serial addition does not match an approved positive adjustment.'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.product_id IS DISTINCT FROM OLD.product_id
       OR NEW.variant_id IS DISTINCT FROM OLD.variant_id
       OR NEW.serial_normalized IS DISTINCT FROM OLD.serial_normalized
       OR NEW.added_by_adjustment_id IS DISTINCT FROM OLD.added_by_adjustment_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Serial identity and origin are immutable.'
            USING ERRCODE = '42501';
    END IF;

    IF OLD.status <> 'IN_STOCK'
       OR NEW.status <> 'REMOVED'
       OR NEW.removed_by_adjustment_id IS NULL
       OR NEW.removed_by_adjustment_id IS NOT DISTINCT FROM OLD.removed_by_adjustment_id THEN
        RAISE EXCEPTION 'A serial unit can only be removed once from IN_STOCK.'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_adjustment
      FROM "inventory_adjustments"
     WHERE "tenant_id" = NEW.tenant_id
       AND "id" = NEW.removed_by_adjustment_id;

    IF NOT FOUND
       OR v_adjustment.status <> 'APPROVED'
       OR v_adjustment.quantity_delta >= 0
       OR v_adjustment.branch_id <> NEW.branch_id
       OR v_adjustment.product_id <> NEW.product_id
       OR v_adjustment.variant_id <> NEW.variant_id
       OR v_adjustment.decided_by IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Serial removal does not match an approved negative adjustment.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "inventory_serial_units_lifecycle"
    BEFORE INSERT OR UPDATE OR DELETE ON "inventory_serial_units"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_inventory_serial_unit();

-- At commit, each approved serial adjustment must have exactly the
-- number of serial additions or removals represented by its delta.
CREATE FUNCTION public.assert_inventory_serial_adjustment_count(
    p_tenant_id UUID,
    p_adjustment_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
    v_adjustment RECORD;
    v_added_count BIGINT;
    v_removed_count BIGINT;
    v_track_serials BOOLEAN;
BEGIN
    SELECT *
      INTO v_adjustment
      FROM "inventory_adjustments"
     WHERE "tenant_id" = p_tenant_id
       AND "id" = p_adjustment_id;

    IF NOT FOUND OR v_adjustment.status <> 'APPROVED' THEN
        RETURN;
    END IF;

    SELECT "track_serials"
      INTO v_track_serials
      FROM "products"
     WHERE "tenant_id" = p_tenant_id
       AND "id" = v_adjustment.product_id;

    IF NOT FOUND OR NOT v_track_serials THEN
        RAISE EXCEPTION 'Approved serial adjustment requires a serial-tracked product.'
            USING ERRCODE = '23514';
    END IF;

    SELECT
        COUNT(*) FILTER (
            WHERE "added_by_adjustment_id" = p_adjustment_id
        ),
        COUNT(*) FILTER (
            WHERE "removed_by_adjustment_id" = p_adjustment_id
        )
      INTO v_added_count, v_removed_count
      FROM "inventory_serial_units"
     WHERE "tenant_id" = p_tenant_id
       AND (
           "added_by_adjustment_id" = p_adjustment_id
           OR "removed_by_adjustment_id" = p_adjustment_id
       );

    IF v_adjustment.quantity_delta > 0 THEN
        IF v_added_count <> v_adjustment.quantity_delta
           OR v_removed_count <> 0 THEN
            RAISE EXCEPTION
                'Serial additions (%) do not match adjustment quantity (%).',
                v_added_count,
                v_adjustment.quantity_delta
                USING ERRCODE = '23514';
        END IF;
    ELSE
        IF v_removed_count <> abs(v_adjustment.quantity_delta)
           OR v_added_count <> 0 THEN
            RAISE EXCEPTION
                'Serial removals (%) do not match adjustment quantity (%).',
                v_removed_count,
                abs(v_adjustment.quantity_delta)
                USING ERRCODE = '23514';
        END IF;
    END IF;
END;
$function$;

CREATE FUNCTION public.check_inventory_serial_adjustment_count()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_TABLE_NAME = 'inventory_adjustments' THEN
        PERFORM public.assert_inventory_serial_adjustment_count(
            NEW.tenant_id,
            NEW.id
        );
    ELSE
        PERFORM public.assert_inventory_serial_adjustment_count(
            NEW.tenant_id,
            NEW.added_by_adjustment_id
        );

        IF NEW.removed_by_adjustment_id IS NOT NULL THEN
            PERFORM public.assert_inventory_serial_adjustment_count(
                NEW.tenant_id,
                NEW.removed_by_adjustment_id
            );
        END IF;
    END IF;

    RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "inventory_adjustment_serial_count"
    AFTER UPDATE ON "inventory_adjustments"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_serial_adjustment_count();

CREATE CONSTRAINT TRIGGER "inventory_serial_adjustment_count"
    AFTER INSERT OR UPDATE ON "inventory_serial_units"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_serial_adjustment_count();

-- For serial-tracked products, in-stock serial count must equal physical
-- quantity. Non-serial-tracked products must not have serial-unit rows.
CREATE FUNCTION public.check_inventory_serial_balance_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_track_serials BOOLEAN;
    v_physical_quantity BIGINT;
    v_serial_count BIGINT;
BEGIN
    SELECT p."track_serials", b."physical_quantity"::bigint
      INTO v_track_serials, v_physical_quantity
      FROM "inventory_balances" b
      JOIN "products" p
        ON p."tenant_id" = b."tenant_id"
       AND p."id" = b."product_id"
     WHERE b."tenant_id" = NEW.tenant_id
       AND b."branch_id" = NEW.branch_id
       AND b."variant_id" = NEW.variant_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'A balance row and product must exist for serial reconciliation.'
            USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*)::bigint
      INTO v_serial_count
      FROM "inventory_serial_units"
     WHERE "tenant_id" = NEW.tenant_id
       AND "branch_id" = NEW.branch_id
       AND "variant_id" = NEW.variant_id
       AND "status" = 'IN_STOCK';

    IF v_track_serials AND v_serial_count <> v_physical_quantity THEN
        RAISE EXCEPTION
            'In-stock serial count (%) does not match physical quantity (%).',
            v_serial_count,
            v_physical_quantity
            USING ERRCODE = '23514';
    END IF;

    IF NOT v_track_serials AND v_serial_count <> 0 THEN
        RAISE EXCEPTION 'Non-serial-tracked products cannot have in-stock serial units.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "inventory_balances_serial_reconciliation"
    AFTER INSERT OR UPDATE ON "inventory_balances"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_serial_balance_reconciliation();

CREATE CONSTRAINT TRIGGER "inventory_serial_units_balance_reconciliation"
    AFTER INSERT OR UPDATE ON "inventory_serial_units"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_serial_balance_reconciliation();


-- Correctly distinguish serial-tracked and ordinary adjustments.
CREATE OR REPLACE FUNCTION public.assert_inventory_serial_adjustment_count(
    p_tenant_id UUID,
    p_adjustment_id UUID
)
RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
    v_adjustment RECORD;
    v_added_count BIGINT;
    v_removed_count BIGINT;
    v_track_serials BOOLEAN;
    v_expected_count BIGINT;
BEGIN
    SELECT *
      INTO v_adjustment
      FROM "inventory_adjustments"
     WHERE "tenant_id" = p_tenant_id
       AND "id" = p_adjustment_id;

    IF NOT FOUND OR v_adjustment.status <> 'APPROVED' THEN
        RETURN;
    END IF;

    SELECT "track_serials"
      INTO v_track_serials
      FROM "products"
     WHERE "tenant_id" = p_tenant_id
       AND "id" = v_adjustment.product_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Adjustment product does not exist.'
            USING ERRCODE = '23514';
    END IF;

    SELECT
        COUNT(*) FILTER (
            WHERE "added_by_adjustment_id" = p_adjustment_id
        ),
        COUNT(*) FILTER (
            WHERE "removed_by_adjustment_id" = p_adjustment_id
        )
      INTO v_added_count, v_removed_count
      FROM "inventory_serial_units"
     WHERE "tenant_id" = p_tenant_id
       AND (
           "added_by_adjustment_id" = p_adjustment_id
           OR "removed_by_adjustment_id" = p_adjustment_id
       );

    IF NOT v_track_serials THEN
        IF jsonb_array_length(v_adjustment.serial_changes) <> 0
           OR v_added_count <> 0
           OR v_removed_count <> 0 THEN
            RAISE EXCEPTION 'Non-serial-tracked adjustments cannot contain serial changes.'
                USING ERRCODE = '23514';
        END IF;

        RETURN;
    END IF;

    v_expected_count := abs(v_adjustment.quantity_delta::bigint);

    IF jsonb_array_length(v_adjustment.serial_changes) <> v_expected_count THEN
        RAISE EXCEPTION
            'Serial change list length does not match adjustment quantity (%).',
            v_expected_count
            USING ERRCODE = '23514';
    END IF;

    IF v_adjustment.quantity_delta > 0 THEN
        IF v_added_count <> v_expected_count OR v_removed_count <> 0 THEN
            RAISE EXCEPTION
                'Serial additions (%) do not match adjustment quantity (%).',
                v_added_count,
                v_expected_count
                USING ERRCODE = '23514';
        END IF;
    ELSE
        IF v_removed_count <> v_expected_count OR v_added_count <> 0 THEN
            RAISE EXCEPTION
                'Serial removals (%) do not match adjustment quantity (%).',
                v_removed_count,
                v_expected_count
                USING ERRCODE = '23514';
        END IF;
    END IF;
END;
$function$;


-- Every inventory operation must begin incomplete.
CREATE FUNCTION public.validate_inventory_operation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.result IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
        RAISE EXCEPTION 'Inventory operations must be created incomplete.'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.actor_user_id IS DISTINCT FROM
       NULLIF(current_setting('app.user_id', true), '')::uuid THEN
        RAISE EXCEPTION 'Inventory operation actor must match the current user.'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "inventory_operations_incomplete_insert"
    BEFORE INSERT ON "inventory_operations"
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_inventory_operation_insert();

-- References to submission, decision and ledger operations must point
-- to operations completed in the same transaction.
CREATE FUNCTION public.check_inventory_operation_completion()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_operation RECORD;
    v_operation_id UUID;
    v_expected_type "InventoryOperationType";
    v_expected_actor UUID;
    v_expected_target UUID;
BEGIN
    IF TG_TABLE_NAME = 'inventory_adjustments' THEN
        IF TG_OP = 'INSERT' THEN
            v_operation_id := NEW.submission_operation_id;
            v_expected_type := 'ADJUSTMENT_SUBMIT';
            v_expected_actor := NEW.requested_by;
            v_expected_target := NEW.id;
        ELSE
            IF NEW.status = 'PENDING' THEN
                RETURN NULL;
            END IF;

            v_operation_id := NEW.decision_operation_id;
            IF NEW.status = 'APPROVED' THEN
                v_expected_type := 'ADJUSTMENT_APPROVE';
            ELSE
                v_expected_type := 'ADJUSTMENT_REJECT';
            END IF;
            v_expected_actor := NEW.decided_by;
            v_expected_target := NEW.id;
        END IF;
    ELSE
        v_operation_id := NEW.operation_id;
        v_expected_type := 'ADJUSTMENT_APPROVE';
        v_expected_actor := NEW.actor_user_id;
        v_expected_target := NEW.adjustment_id;
    END IF;

    SELECT *
      INTO v_operation
      FROM "inventory_operations"
     WHERE "tenant_id" = NEW.tenant_id
       AND "id" = v_operation_id;

    IF NOT FOUND
       OR v_operation.operation_type <> v_expected_type
       OR v_operation.actor_user_id <> v_expected_actor
       OR v_operation.target_id IS DISTINCT FROM v_expected_target
       OR v_operation.completed_at IS NULL
       OR v_operation.result IS NULL THEN
        RAISE EXCEPTION 'Inventory record references an incomplete or mismatched operation.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "inventory_adjustment_operation_completion"
    AFTER INSERT OR UPDATE ON "inventory_adjustments"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_operation_completion();

CREATE CONSTRAINT TRIGGER "inventory_ledger_operation_completion"
    AFTER INSERT ON "inventory_ledger_entries"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_operation_completion();


-- Every approved adjustment must have exactly one ledger entry at commit.
-- Pending and rejected adjustments must have none.
CREATE FUNCTION public.check_inventory_adjustment_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_status "InventoryAdjustmentStatus";
    v_ledger_count BIGINT;
BEGIN
    SELECT "status"
      INTO v_status
      FROM "inventory_adjustments"
     WHERE "tenant_id" = NEW.tenant_id
       AND "id" = NEW.id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Adjustment disappeared during ledger reconciliation.'
            USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*)::bigint
      INTO v_ledger_count
      FROM "inventory_ledger_entries"
     WHERE "tenant_id" = NEW.tenant_id
       AND "adjustment_id" = NEW.id;

    IF v_status = 'APPROVED' AND v_ledger_count <> 1 THEN
        RAISE EXCEPTION
            'An approved adjustment must have exactly one ledger entry; found %.',
            v_ledger_count
            USING ERRCODE = '23514';
    END IF;

    IF v_status <> 'APPROVED' AND v_ledger_count <> 0 THEN
        RAISE EXCEPTION
            'A pending or rejected adjustment cannot have a ledger entry.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "inventory_adjustment_ledger_required"
    AFTER INSERT OR UPDATE ON "inventory_adjustments"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_adjustment_ledger_entry();

CREATE CONSTRAINT TRIGGER "inventory_ledger_adjustment_required"
    AFTER INSERT ON "inventory_ledger_entries"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_adjustment_ledger_entry();


-- Ledger rows expose adjustment_id, while adjustment rows expose id.
-- Resolve the correct key for both deferred constraint triggers.
CREATE OR REPLACE FUNCTION public.check_inventory_adjustment_ledger_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_tenant_id UUID;
    v_adjustment_id UUID;
    v_status "InventoryAdjustmentStatus";
    v_ledger_count BIGINT;
BEGIN
    v_tenant_id := NEW.tenant_id;

    IF TG_TABLE_NAME = 'inventory_adjustments' THEN
        v_adjustment_id := NEW.id;
    ELSE
        v_adjustment_id := NEW.adjustment_id;
    END IF;

    SELECT "status"
      INTO v_status
      FROM "inventory_adjustments"
     WHERE "tenant_id" = v_tenant_id
       AND "id" = v_adjustment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Adjustment missing during ledger reconciliation.'
            USING ERRCODE = '23514';
    END IF;

    SELECT COUNT(*)::bigint
      INTO v_ledger_count
      FROM "inventory_ledger_entries"
     WHERE "tenant_id" = v_tenant_id
       AND "adjustment_id" = v_adjustment_id;

    IF v_status = 'APPROVED' AND v_ledger_count <> 1 THEN
        RAISE EXCEPTION
            'An approved adjustment must have exactly one ledger entry; found %.',
            v_ledger_count
            USING ERRCODE = '23514';
    END IF;

    IF v_status <> 'APPROVED' AND v_ledger_count <> 0 THEN
        RAISE EXCEPTION
            'A pending or rejected adjustment cannot have a ledger entry.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$function$;


-- Serial-tracking mode is part of a product's inventory identity.
-- Freeze it once a balance or serial-unit record exists.
CREATE FUNCTION public.protect_product_serial_tracking_mode()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW."track_serials" IS DISTINCT FROM OLD."track_serials"
       AND (
           EXISTS (
               SELECT 1
                 FROM "inventory_balances"
                WHERE "tenant_id" = NEW."tenant_id"
                  AND "product_id" = NEW."id"
           )
           OR EXISTS (
               SELECT 1
                 FROM "inventory_serial_units"
                WHERE "tenant_id" = NEW."tenant_id"
                  AND "product_id" = NEW."id"
           )
       ) THEN
        RAISE EXCEPTION
            'Serial-tracking mode cannot change after inventory records exist.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "products_serial_tracking_mode_immutable"
    BEFORE UPDATE OF "track_serials" ON "products"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_product_serial_tracking_mode();

-- No inventory operation may remain incomplete at transaction commit.
CREATE FUNCTION public.check_inventory_operation_completed_at_commit()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_completed_at TIMESTAMPTZ;
    v_result JSONB;
BEGIN
    SELECT "completed_at", "result"
      INTO v_completed_at, v_result
      FROM "inventory_operations"
     WHERE "tenant_id" = NEW.tenant_id
       AND "id" = NEW.id;

    IF NOT FOUND
       OR v_completed_at IS NULL
       OR v_result IS NULL THEN
        RAISE EXCEPTION
            'Inventory operation must be completed before transaction commit.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "inventory_operations_completed_at_commit"
    AFTER INSERT OR UPDATE ON "inventory_operations"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION public.check_inventory_operation_completed_at_commit();

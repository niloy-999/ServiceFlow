-- M3.2: tenant-scoped purchase orders and immutable submitted contents.
-- This migration does not modify inventory balances, operations, or ledger entries.

CREATE TYPE "PurchaseOrderStatus" AS ENUM (
    'DRAFT',
    'PENDING_APPROVAL',
    'WITHDRAWN',
    'APPROVED',
    'PARTIALLY_RECEIVED',
    'RECEIVED',
    'CANCELLED'
);

-- Tenant-scoped, transactional PO number allocator.
CREATE TABLE "purchase_order_counters" (
    "tenant_id" UUID NOT NULL,
    "next_number" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_order_counters_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "purchase_order_counters_next_number_check"
        CHECK ("next_number" > 0),
    CONSTRAINT "purchase_order_counters_business_fkey"
        FOREIGN KEY ("tenant_id")
        REFERENCES "businesses"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "order_number" VARCHAR(64) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" VARCHAR(2000),

    "created_by_user_id" UUID NOT NULL,
    "submitted_by_user_id" UUID,
    "submitted_at" TIMESTAMPTZ(3),
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "cancelled_by_user_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancellation_reason" VARCHAR(1000),
    "withdrawn_by_user_id" UUID,
    "withdrawn_at" TIMESTAMPTZ(3),
    "withdrawal_reason" VARCHAR(1000),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_orders_tenant_id_id_key"
        UNIQUE ("tenant_id", "id"),
    CONSTRAINT "purchase_orders_tenant_id_order_number_key"
        UNIQUE ("tenant_id", "order_number"),

    CONSTRAINT "purchase_orders_order_number_check"
        CHECK (length(btrim("order_number")) > 0),
    CONSTRAINT "purchase_orders_currency_check"
        CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "purchase_orders_version_check"
        CHECK ("version" > 0),

    CONSTRAINT "purchase_orders_lifecycle_metadata_check"
        CHECK (
            (
                "status" = 'DRAFT'
                AND "submitted_by_user_id" IS NULL
                AND "submitted_at" IS NULL
                AND "approved_by_user_id" IS NULL
                AND "approved_at" IS NULL
                AND "cancelled_by_user_id" IS NULL
                AND "cancelled_at" IS NULL
                AND "cancellation_reason" IS NULL
                AND "withdrawn_by_user_id" IS NULL
                AND "withdrawn_at" IS NULL
                AND "withdrawal_reason" IS NULL
            )
            OR
            (
                "status" = 'PENDING_APPROVAL'
                AND "submitted_by_user_id" IS NOT NULL
                AND "submitted_at" IS NOT NULL
                AND "approved_by_user_id" IS NULL
                AND "approved_at" IS NULL
                AND "cancelled_by_user_id" IS NULL
                AND "cancelled_at" IS NULL
                AND "cancellation_reason" IS NULL
                AND "withdrawn_by_user_id" IS NULL
                AND "withdrawn_at" IS NULL
                AND "withdrawal_reason" IS NULL
            )
            OR
            (
                "status" = 'WITHDRAWN'
                AND "submitted_by_user_id" IS NOT NULL
                AND "submitted_at" IS NOT NULL
                AND "approved_by_user_id" IS NULL
                AND "approved_at" IS NULL
                AND "cancelled_by_user_id" IS NULL
                AND "cancelled_at" IS NULL
                AND "cancellation_reason" IS NULL
                AND "withdrawn_by_user_id" IS NOT NULL
                AND "withdrawn_at" IS NOT NULL
                AND length(btrim(coalesce("withdrawal_reason", ''))) > 0
            )
            OR
            (
                "status" IN ('APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED')
                AND "submitted_by_user_id" IS NOT NULL
                AND "submitted_at" IS NOT NULL
                AND "approved_by_user_id" IS NOT NULL
                AND "approved_at" IS NOT NULL
                AND "cancelled_by_user_id" IS NULL
                AND "cancelled_at" IS NULL
                AND "cancellation_reason" IS NULL
                AND "withdrawn_by_user_id" IS NULL
                AND "withdrawn_at" IS NULL
                AND "withdrawal_reason" IS NULL
                AND "submitted_by_user_id" <> "approved_by_user_id"
            )
            OR
            (
                "status" = 'CANCELLED'
                AND "cancelled_by_user_id" IS NOT NULL
                AND "cancelled_at" IS NOT NULL
                AND length(btrim(coalesce("cancellation_reason", ''))) > 0
                AND "withdrawn_by_user_id" IS NULL
                AND "withdrawn_at" IS NULL
                AND "withdrawal_reason" IS NULL
                AND (
                    (
                        "submitted_by_user_id" IS NULL
                        AND "submitted_at" IS NULL
                        AND "approved_by_user_id" IS NULL
                        AND "approved_at" IS NULL
                    )
                    OR
                    (
                        "submitted_by_user_id" IS NOT NULL
                        AND "submitted_at" IS NOT NULL
                        AND "approved_by_user_id" IS NOT NULL
                        AND "approved_at" IS NOT NULL
                        AND "submitted_by_user_id" <> "approved_by_user_id"
                    )
                )
            )
        ),

    CONSTRAINT "purchase_orders_business_fkey"
        FOREIGN KEY ("tenant_id")
        REFERENCES "businesses"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "purchase_orders_branch_fkey"
        FOREIGN KEY ("tenant_id", "branch_id")
        REFERENCES "branches"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "purchase_orders_supplier_fkey"
        FOREIGN KEY ("tenant_id", "supplier_id")
        REFERENCES "suppliers"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "purchase_orders_creator_membership_fkey"
        FOREIGN KEY ("tenant_id", "created_by_user_id")
        REFERENCES "tenant_memberships"("tenant_id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "purchase_orders_submitter_membership_fkey"
        FOREIGN KEY ("tenant_id", "submitted_by_user_id")
        REFERENCES "tenant_memberships"("tenant_id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "purchase_orders_approver_membership_fkey"
        FOREIGN KEY ("tenant_id", "approved_by_user_id")
        REFERENCES "tenant_memberships"("tenant_id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "purchase_orders_canceller_membership_fkey"
        FOREIGN KEY ("tenant_id", "cancelled_by_user_id")
        REFERENCES "tenant_memberships"("tenant_id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "purchase_orders_withdrawer_membership_fkey"
        FOREIGN KEY ("tenant_id", "withdrawn_by_user_id")
        REFERENCES "tenant_memberships"("tenant_id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "purchase_orders_tenant_branch_status_created_idx"
    ON "purchase_orders"("tenant_id", "branch_id", "status", "created_at");

CREATE INDEX "purchase_orders_tenant_supplier_status_idx"
    ON "purchase_orders"("tenant_id", "supplier_id", "status");

CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,

    "product_code_snapshot" VARCHAR(64) NOT NULL,
    "product_name_snapshot" VARCHAR(180) NOT NULL,
    "variant_code_snapshot" VARCHAR(64) NOT NULL,
    "sku_snapshot" VARCHAR(100) NOT NULL,
    "variant_name_snapshot" VARCHAR(180) NOT NULL,

    "ordered_quantity" INTEGER NOT NULL,
    "unit_cost_minor" BIGINT NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "purchase_order_lines_tenant_id_id_key"
        UNIQUE ("tenant_id", "id"),

    CONSTRAINT "purchase_order_lines_quantity_check"
        CHECK ("ordered_quantity" > 0),
    CONSTRAINT "purchase_order_lines_unit_cost_check"
        CHECK ("unit_cost_minor" >= 0),

    CONSTRAINT "purchase_order_lines_product_code_check"
        CHECK (length(btrim("product_code_snapshot")) > 0),
    CONSTRAINT "purchase_order_lines_product_name_check"
        CHECK (length(btrim("product_name_snapshot")) > 0),
    CONSTRAINT "purchase_order_lines_variant_code_check"
        CHECK (length(btrim("variant_code_snapshot")) > 0),
    CONSTRAINT "purchase_order_lines_sku_check"
        CHECK (length(btrim("sku_snapshot")) > 0),
    CONSTRAINT "purchase_order_lines_variant_name_check"
        CHECK (length(btrim("variant_name_snapshot")) > 0),

    CONSTRAINT "purchase_order_lines_purchase_order_fkey"
        FOREIGN KEY ("tenant_id", "purchase_order_id")
        REFERENCES "purchase_orders"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "purchase_order_lines_product_fkey"
        FOREIGN KEY ("tenant_id", "product_id")
        REFERENCES "products"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,

    CONSTRAINT "purchase_order_lines_variant_fkey"
        FOREIGN KEY ("tenant_id", "product_id", "variant_id")
        REFERENCES "product_variants"("tenant_id", "product_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "purchase_order_lines_tenant_order_idx"
    ON "purchase_order_lines"("tenant_id", "purchase_order_id");

CREATE INDEX "purchase_order_lines_tenant_variant_idx"
    ON "purchase_order_lines"("tenant_id", "variant_id");

CREATE TYPE "PurchaseOrderCancellationStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED'
);

CREATE TABLE "purchase_order_cancellation_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "request_reason" VARCHAR(1000) NOT NULL,
    "status" "PurchaseOrderCancellationStatus" NOT NULL DEFAULT 'PENDING',
    "decided_by_user_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "purchase_order_cancellation_requests_pkey"
        PRIMARY KEY ("id"),
    CONSTRAINT "purchase_order_cancellation_requests_tenant_id_id_key"
        UNIQUE ("tenant_id", "id"),
    CONSTRAINT "purchase_order_cancellation_requests_reason_check"
        CHECK (length(btrim(coalesce("request_reason", ''))) > 0),
    CONSTRAINT "purchase_order_cancellation_requests_decision_check"
        CHECK (
            (
                "status" = 'PENDING'
                AND "decided_by_user_id" IS NULL
                AND "decided_at" IS NULL
                AND "decision_reason" IS NULL
            )
            OR
            (
                "status" = 'APPROVED'
                AND "decided_by_user_id" IS NOT NULL
                AND "decided_at" IS NOT NULL
                AND (
                    "decision_reason" IS NULL
                    OR length(btrim("decision_reason")) > 0
                )
            )
            OR
            (
                "status" = 'REJECTED'
                AND "decided_by_user_id" IS NOT NULL
                AND "decided_at" IS NOT NULL
                AND length(btrim(coalesce("decision_reason", ''))) > 0
            )
        ),
    CONSTRAINT "purchase_order_cancellation_requests_version_check"
        CHECK ("version" > 0),
    CONSTRAINT "purchase_order_cancellation_requests_order_fkey"
        FOREIGN KEY ("tenant_id", "purchase_order_id")
        REFERENCES "purchase_orders"("tenant_id", "id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "purchase_order_cancellation_requests_requester_fkey"
        FOREIGN KEY ("tenant_id", "requested_by_user_id")
        REFERENCES "tenant_memberships"("tenant_id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "purchase_order_cancellation_requests_reviewer_fkey"
        FOREIGN KEY ("tenant_id", "decided_by_user_id")
        REFERENCES "tenant_memberships"("tenant_id", "user_id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "purchase_order_cancellation_requests_tenant_order_idx"
    ON "purchase_order_cancellation_requests"("tenant_id", "purchase_order_id", "requested_at");

CREATE INDEX "purchase_order_cancellation_requests_tenant_status_idx"
    ON "purchase_order_cancellation_requests"("tenant_id", "status", "requested_at");

CREATE UNIQUE INDEX "purchase_order_cancellation_requests_one_pending_per_order_key"
    ON "purchase_order_cancellation_requests"("tenant_id", "purchase_order_id")
    WHERE "status" = 'PENDING';

-- Lock and validate supplier/branch while creating a draft PO.
-- The supplier lock serializes PO creation with supplier archival.
CREATE FUNCTION public.validate_purchase_order_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_supplier_status "CatalogueStatus";
    v_branch_status TEXT;
BEGIN
    IF NEW."created_by_user_id" IS DISTINCT FROM
       NULLIF(current_setting('app.user_id', true), '')::uuid THEN
        RAISE EXCEPTION 'Purchase order creator must match the authenticated user.'
            USING ERRCODE = '42501';
    END IF;

    SELECT "status"
    INTO v_supplier_status
    FROM "suppliers"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."supplier_id"
    FOR SHARE;

    IF NOT FOUND OR v_supplier_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Purchase order supplier is unavailable.'
            USING ERRCODE = '23514';
    END IF;

    SELECT "status"
    INTO v_branch_status
    FROM "branches"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."branch_id"
    FOR SHARE;

    IF NOT FOUND OR v_branch_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Purchase order branch is unavailable.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "purchase_orders_validate_insert"
    BEFORE INSERT ON "purchase_orders"
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_purchase_order_insert();

-- Header identity and lifecycle are protected at the database boundary.
CREATE FUNCTION public.protect_purchase_order()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_actor UUID;
    v_line_count BIGINT;
    v_product_status "CatalogueStatus";
    v_variant_status "CatalogueStatus";
    v_approved_request_count BIGINT;
BEGIN
    v_actor := NULLIF(current_setting('app.user_id', true), '')::uuid;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Purchase orders cannot be deleted.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."branch_id" IS DISTINCT FROM OLD."branch_id"
       OR NEW."supplier_id" IS DISTINCT FROM OLD."supplier_id"
       OR NEW."order_number" IS DISTINCT FROM OLD."order_number"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'Purchase order identity and ownership are immutable.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
        RAISE EXCEPTION 'Purchase order updates must increment version exactly once.'
            USING ERRCODE = '42501';
    END IF;

    IF OLD."status" <> 'DRAFT'
       AND NEW."notes" IS DISTINCT FROM OLD."notes" THEN
        RAISE EXCEPTION 'Submitted purchase order contents are immutable.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW."status" = OLD."status" THEN
        IF NEW."submitted_by_user_id" IS DISTINCT FROM OLD."submitted_by_user_id"
           OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
           OR NEW."approved_by_user_id" IS DISTINCT FROM OLD."approved_by_user_id"
           OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
           OR NEW."cancelled_by_user_id" IS DISTINCT FROM OLD."cancelled_by_user_id"
           OR NEW."cancelled_at" IS DISTINCT FROM OLD."cancelled_at"
           OR NEW."cancellation_reason" IS DISTINCT FROM OLD."cancellation_reason"
           OR NEW."withdrawn_by_user_id" IS DISTINCT FROM OLD."withdrawn_by_user_id"
           OR NEW."withdrawn_at" IS DISTINCT FROM OLD."withdrawn_at"
           OR NEW."withdrawal_reason" IS DISTINCT FROM OLD."withdrawal_reason" THEN
            RAISE EXCEPTION 'Purchase order lifecycle metadata cannot be rewritten.'
                USING ERRCODE = '42501';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD."status" = 'DRAFT'
       AND NEW."status" = 'PENDING_APPROVAL' THEN

        IF NEW."submitted_by_user_id" IS DISTINCT FROM v_actor
           OR NEW."submitted_at" IS NULL THEN
            RAISE EXCEPTION 'Submission actor must match the authenticated user.'
                USING ERRCODE = '42501';
        END IF;

        SELECT count(*)
        INTO v_line_count
        FROM "purchase_order_lines"
        WHERE "tenant_id" = NEW."tenant_id"
          AND "purchase_order_id" = NEW."id";

        IF v_line_count = 0 THEN
            RAISE EXCEPTION 'A purchase order requires at least one line before submission.'
                USING ERRCODE = '23514';
        END IF;

        FOR v_product_status, v_variant_status IN
            SELECT p."status", pv."status"
            FROM "purchase_order_lines" pol
            JOIN "products" p
              ON p."tenant_id" = pol."tenant_id"
             AND p."id" = pol."product_id"
            JOIN "product_variants" pv
              ON pv."tenant_id" = pol."tenant_id"
             AND pv."product_id" = pol."product_id"
             AND pv."id" = pol."variant_id"
            WHERE pol."tenant_id" = NEW."tenant_id"
              AND pol."purchase_order_id" = NEW."id"
            ORDER BY p."id", pv."id"
            FOR SHARE OF p, pv
        LOOP
            IF v_product_status <> 'ACTIVE'
               OR v_variant_status <> 'ACTIVE' THEN
                RAISE EXCEPTION 'Archived products or variants cannot be submitted on a purchase order.'
                    USING ERRCODE = '23514';
            END IF;
        END LOOP;

        RETURN NEW;
    END IF;

    IF OLD."status" = 'PENDING_APPROVAL'
       AND NEW."status" = 'APPROVED' THEN

        IF NEW."submitted_by_user_id" IS DISTINCT FROM OLD."submitted_by_user_id"
           OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
           OR NEW."approved_by_user_id" IS DISTINCT FROM v_actor
           OR NEW."approved_at" IS NULL
           OR NEW."approved_by_user_id" = OLD."submitted_by_user_id" THEN
            RAISE EXCEPTION 'Approval requires an authenticated user different from the submitter.'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD."status" = 'PENDING_APPROVAL'
       AND NEW."status" = 'WITHDRAWN' THEN

        IF NEW."submitted_by_user_id" IS DISTINCT FROM OLD."submitted_by_user_id"
           OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
           OR NEW."approved_by_user_id" IS NOT NULL
           OR NEW."approved_at" IS NOT NULL
           OR NEW."withdrawn_by_user_id" IS DISTINCT FROM v_actor
           OR NEW."withdrawn_at" IS NULL
           OR length(btrim(coalesce(NEW."withdrawal_reason", ''))) = 0 THEN
            RAISE EXCEPTION 'Withdrawal requires the authenticated actor, timestamp, and reason.'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD."status" = 'DRAFT'
       AND NEW."status" = 'CANCELLED' THEN

        IF NEW."submitted_by_user_id" IS NOT NULL
           OR NEW."submitted_at" IS NOT NULL
           OR NEW."approved_by_user_id" IS NOT NULL
           OR NEW."approved_at" IS NOT NULL
           OR NEW."cancelled_by_user_id" IS DISTINCT FROM v_actor
           OR NEW."cancelled_at" IS NULL
           OR length(btrim(coalesce(NEW."cancellation_reason", ''))) = 0 THEN
            RAISE EXCEPTION 'Draft cancellation requires the authenticated actor, timestamp, and reason.'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    IF OLD."status" = 'APPROVED'
       AND NEW."status" = 'CANCELLED' THEN

        IF NEW."submitted_by_user_id" IS DISTINCT FROM OLD."submitted_by_user_id"
           OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
           OR NEW."approved_by_user_id" IS DISTINCT FROM OLD."approved_by_user_id"
           OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
           OR NEW."cancelled_by_user_id" IS DISTINCT FROM v_actor
           OR NEW."cancelled_at" IS NULL
           OR length(btrim(coalesce(NEW."cancellation_reason", ''))) = 0 THEN
            RAISE EXCEPTION 'Approved PO cancellation requires an authenticated reviewer and reason.'
                USING ERRCODE = '23514';
        END IF;

        SELECT count(*)
        INTO v_approved_request_count
        FROM "purchase_order_cancellation_requests" r
        WHERE r."tenant_id" = NEW."tenant_id"
          AND r."purchase_order_id" = NEW."id"
          AND r."status" = 'APPROVED'
          AND r."decided_by_user_id" = v_actor
          AND r."request_reason" = NEW."cancellation_reason"
          AND r."decided_at" = NEW."cancelled_at";

        IF v_approved_request_count = 0 THEN
            RAISE EXCEPTION 'An approved cancellation request is required.'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Invalid purchase order lifecycle transition: % -> %.',
        OLD."status", NEW."status"
        USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER "purchase_orders_protect_lifecycle"
    BEFORE UPDATE OR DELETE ON "purchase_orders"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_purchase_order();

CREATE FUNCTION public.protect_purchase_order_cancellation_request()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_actor UUID;
    v_order_status "PurchaseOrderStatus";
    v_order_creator UUID;
BEGIN
    v_actor := NULLIF(current_setting('app.user_id', true), '')::uuid;

    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Cancellation request history cannot be deleted.'
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."requested_by_user_id" IS DISTINCT FROM v_actor
           OR NEW."status" <> 'PENDING'
           OR NEW."decided_by_user_id" IS NOT NULL
           OR NEW."decided_at" IS NOT NULL
           OR NEW."decision_reason" IS NOT NULL
           OR length(btrim(NEW."request_reason")) = 0 THEN
            RAISE EXCEPTION 'Cancellation request must be created by the authenticated user with a reason.'
                USING ERRCODE = '42501';
        END IF;

        SELECT "status", "created_by_user_id"
        INTO v_order_status, v_order_creator
        FROM "purchase_orders"
        WHERE "tenant_id" = NEW."tenant_id"
          AND "id" = NEW."purchase_order_id"
        FOR UPDATE;

        IF NOT FOUND
           OR v_order_status <> 'APPROVED'
           OR NEW."requested_by_user_id" IS DISTINCT FROM v_order_creator THEN
            RAISE EXCEPTION 'Only the original creator can request cancellation of an approved purchase order.'
                USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."purchase_order_id" IS DISTINCT FROM OLD."purchase_order_id"
       OR NEW."requested_by_user_id" IS DISTINCT FROM OLD."requested_by_user_id"
       OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
       OR NEW."request_reason" IS DISTINCT FROM OLD."request_reason"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'Cancellation request identity and request history are immutable.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
        RAISE EXCEPTION 'Cancellation request updates must increment version exactly once.'
            USING ERRCODE = '42501';
    END IF;

    IF OLD."status" <> 'PENDING'
       OR NEW."status" NOT IN ('APPROVED', 'REJECTED')
       OR NEW."decided_by_user_id" IS DISTINCT FROM v_actor
       OR NEW."decided_by_user_id" = OLD."requested_by_user_id"
       OR NEW."decided_at" IS NULL
       OR (
           NEW."status" = 'REJECTED'
           AND length(btrim(coalesce(NEW."decision_reason", ''))) = 0
       )
       OR (
           NEW."decision_reason" IS NOT NULL
           AND length(btrim(NEW."decision_reason")) = 0
       ) THEN
        RAISE EXCEPTION 'Cancellation decision requires a different authenticated reviewer and reason.'
            USING ERRCODE = '42501';
    END IF;

    SELECT "status"
    INTO v_order_status
    FROM "purchase_orders"
    WHERE "tenant_id" = NEW."tenant_id"
      AND "id" = NEW."purchase_order_id"
    FOR UPDATE;

    IF NOT FOUND OR v_order_status <> 'APPROVED' THEN
        RAISE EXCEPTION 'Cancellation decision requires the purchase order to remain approved.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "purchase_order_cancellation_requests_protect"
    BEFORE INSERT OR UPDATE OR DELETE
    ON "purchase_order_cancellation_requests"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_purchase_order_cancellation_request();

CREATE FUNCTION public.finalize_purchase_order_cancellation_request()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF OLD."status" = 'PENDING' AND NEW."status" = 'APPROVED' THEN
        UPDATE "purchase_orders"
        SET "status" = 'CANCELLED',
            "cancelled_by_user_id" = NEW."decided_by_user_id",
            "cancelled_at" = NEW."decided_at",
            "cancellation_reason" = NEW."request_reason",
            "updated_at" = NEW."decided_at",
            "version" = "version" + 1
        WHERE "tenant_id" = NEW."tenant_id"
          AND "id" = NEW."purchase_order_id"
          AND "status" = 'APPROVED';

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Purchase order could not be cancelled from its current state.'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "purchase_order_cancellation_requests_finalize"
    AFTER UPDATE OF "status"
    ON "purchase_order_cancellation_requests"
    FOR EACH ROW
    EXECUTE FUNCTION public.finalize_purchase_order_cancellation_request();

-- Lines may be inserted, updated, or deleted only while their parent is DRAFT.
-- Locking the parent serializes line edits against submission.
CREATE FUNCTION public.protect_purchase_order_line()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_tenant_id UUID;
    v_order_id UUID;
    v_status "PurchaseOrderStatus";
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_tenant_id := OLD."tenant_id";
        v_order_id := OLD."purchase_order_id";
    ELSE
        v_tenant_id := NEW."tenant_id";
        v_order_id := NEW."purchase_order_id";
    END IF;

    SELECT "status"
    INTO v_status
    FROM "purchase_orders"
    WHERE "tenant_id" = v_tenant_id
      AND "id" = v_order_id
    FOR UPDATE;

    IF NOT FOUND OR v_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Purchase order lines can only change while the order is a draft.'
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW."id" IS DISTINCT FROM OLD."id"
           OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
           OR NEW."purchase_order_id" IS DISTINCT FROM OLD."purchase_order_id"
           OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
           OR NEW."variant_id" IS DISTINCT FROM OLD."variant_id"
           OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
            RAISE EXCEPTION 'Purchase order line identity is immutable; replace the line instead.'
                USING ERRCODE = '42501';
        END IF;

        IF NEW."product_code_snapshot" IS DISTINCT FROM OLD."product_code_snapshot"
           OR NEW."product_name_snapshot" IS DISTINCT FROM OLD."product_name_snapshot"
           OR NEW."variant_code_snapshot" IS DISTINCT FROM OLD."variant_code_snapshot"
           OR NEW."sku_snapshot" IS DISTINCT FROM OLD."sku_snapshot"
           OR NEW."variant_name_snapshot" IS DISTINCT FROM OLD."variant_name_snapshot" THEN
            RAISE EXCEPTION 'Purchase order line snapshots are immutable.'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF TG_OP = 'INSERT' THEN
        SELECT
            p."product_code",
            p."name",
            pv."variant_code",
            pv."sku",
            pv."name"
        INTO
            NEW."product_code_snapshot",
            NEW."product_name_snapshot",
            NEW."variant_code_snapshot",
            NEW."sku_snapshot",
            NEW."variant_name_snapshot"
        FROM "products" p
        JOIN "product_variants" pv
          ON pv."tenant_id" = p."tenant_id"
         AND pv."product_id" = p."id"
        WHERE p."tenant_id" = NEW."tenant_id"
          AND p."id" = NEW."product_id"
          AND pv."id" = NEW."variant_id"
          AND p."status" = 'ACTIVE'
          AND pv."status" = 'ACTIVE'
        FOR SHARE OF p, pv;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Purchase order lines require an active product and variant.'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "purchase_order_lines_protect_draft"
    BEFORE INSERT OR UPDATE OR DELETE ON "purchase_order_lines"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_purchase_order_line();

-- Supplier archival is blocked while any open purchase order references it.
CREATE OR REPLACE FUNCTION public.protect_supplier()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Suppliers cannot be deleted; archive them instead.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
        RAISE EXCEPTION 'Supplier identity and ownership are immutable.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW."version" IS DISTINCT FROM OLD."version" + 1 THEN
        RAISE EXCEPTION 'Supplier updates must increment version exactly once.'
            USING ERRCODE = '42501';
    END IF;

    IF OLD."status" = 'ACTIVE' AND NEW."status" = 'ARCHIVED'
       AND EXISTS (
           SELECT 1
           FROM "purchase_orders" po
           WHERE po."tenant_id" = OLD."tenant_id"
             AND po."supplier_id" = OLD."id"
             AND po."status" IN (
                 'DRAFT',
                 'PENDING_APPROVAL',
                 'APPROVED',
                 'PARTIALLY_RECEIVED'
             )
       ) THEN
        RAISE EXCEPTION 'Supplier cannot be archived while open purchase orders exist.'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$function$;

-- Tenant isolation and least-privilege runtime access.
ALTER TABLE "purchase_order_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_cancellation_requests" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
    ON "purchase_order_counters"
    FOR ALL TO serviceflow_app
    USING (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY tenant_isolation
    ON "purchase_orders"
    FOR ALL TO serviceflow_app
    USING (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY tenant_isolation
    ON "purchase_order_lines"
    FOR ALL TO serviceflow_app
    USING (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

CREATE POLICY tenant_isolation
    ON "purchase_order_cancellation_requests"
    FOR ALL TO serviceflow_app
    USING (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" =
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

REVOKE ALL ON TABLE
    "purchase_order_counters",
    "purchase_orders",
    "purchase_order_lines",
    "purchase_order_cancellation_requests"
FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE
    ON TABLE "purchase_order_counters"
    TO serviceflow_app;

GRANT SELECT, INSERT, UPDATE
    ON TABLE "purchase_orders"
    TO serviceflow_app;

GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE "purchase_order_lines"
    TO serviceflow_app;

GRANT SELECT, INSERT, UPDATE
    ON TABLE "purchase_order_cancellation_requests"
    TO serviceflow_app;

REVOKE DELETE ON TABLE
    "purchase_order_counters",
    "purchase_orders"
FROM serviceflow_app;

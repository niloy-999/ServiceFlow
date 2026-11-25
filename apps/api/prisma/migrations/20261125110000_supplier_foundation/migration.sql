-- CreateTable
CREATE TABLE "suppliers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "name_normalized" VARCHAR(160) NOT NULL,
    "contact_name" VARCHAR(160),
    "email" VARCHAR(320),
    "phone" VARCHAR(40),
    "address" VARCHAR(500),
    "notes" VARCHAR(2000),
    "status" "CatalogueStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "suppliers_name_nonblank_check"
        CHECK (length(btrim("name")) > 0),
    CONSTRAINT "suppliers_name_normalized_check"
        CHECK (
            "name_normalized" = upper(btrim("name_normalized"))
            AND length(btrim("name_normalized")) > 0
        ),
    CONSTRAINT "suppliers_version_positive_check"
        CHECK ("version" > 0)
);

-- CreateIndex
CREATE INDEX "suppliers_tenant_id_status_name_idx" ON "suppliers"("tenant_id", "status", "name");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenant_id_id_key" ON "suppliers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_tenant_id_name_normalized_key" ON "suppliers"("tenant_id", "name_normalized");

-- AddForeignKey
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Suppliers are tenant-isolated and archived rather than deleted.
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation
    ON "suppliers"
    FOR ALL TO serviceflow_app
    USING (
        "tenant_id" =
            NULLIF(current_setting('app.tenant_id', true), '')::uuid
    )
    WITH CHECK (
        "tenant_id" =
            NULLIF(current_setting('app.tenant_id', true), '')::uuid
    );

REVOKE ALL ON TABLE "suppliers" FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE "suppliers" TO serviceflow_app;
REVOKE DELETE ON TABLE "suppliers" FROM serviceflow_app;

-- Supplier identity cannot be moved between tenants or hard-deleted.
-- Every update must advance the optimistic concurrency version exactly once.
CREATE FUNCTION public.protect_supplier()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Suppliers cannot be deleted; archive them instead.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Supplier identity and ownership are immutable.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.version IS DISTINCT FROM OLD.version + 1 THEN
        RAISE EXCEPTION 'Supplier updates must increment version exactly once.'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE TRIGGER "suppliers_protect_identity_and_delete"
    BEFORE UPDATE OR DELETE ON "suppliers"
    FOR EACH ROW
    EXECUTE FUNCTION public.protect_supplier();

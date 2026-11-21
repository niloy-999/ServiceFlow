-- CreateTable
CREATE TABLE "platform_administrators" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(40) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    "granted_by_user_id" UUID,
    "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_by_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,

    CONSTRAINT "platform_administrators_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_administrators_status_role_idx" ON "platform_administrators"("status", "role");

-- AddForeignKey
ALTER TABLE "platform_administrators" ADD CONSTRAINT "platform_administrators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_administrators" ADD CONSTRAINT "platform_administrators_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_administrators" ADD CONSTRAINT "platform_administrators_revoked_by_user_id_fkey" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restrict platform roles and grant lifecycle states.
ALTER TABLE "platform_administrators"
    ADD CONSTRAINT "platform_administrators_role_check"
    CHECK ("role" IN ('PLATFORM_ADMIN', 'PLATFORM_SECURITY_OPERATOR'));

ALTER TABLE "platform_administrators"
    ADD CONSTRAINT "platform_administrators_status_check"
    CHECK ("status" IN ('ACTIVE', 'SUSPENDED'));

-- A grant must have consistent revocation metadata.
ALTER TABLE "platform_administrators"
    ADD CONSTRAINT "platform_administrators_revocation_metadata_check"
    CHECK (
        ("revoked_at" IS NULL AND "revoked_by_user_id" IS NULL)
        OR
        ("revoked_at" IS NOT NULL AND "revoked_by_user_id" IS NOT NULL)
    );

ALTER TABLE "platform_administrators"
    ADD CONSTRAINT "platform_administrators_version_check"
    CHECK ("version" > 0);

-- Preserve historical grants while allowing at most one non-revoked
-- grant record per user.
CREATE UNIQUE INDEX "platform_administrators_one_current_grant_per_user"
    ON "platform_administrators" ("user_id")
    WHERE "revoked_at" IS NULL;

-- The application runtime may inspect grants but cannot create,
-- modify, or delete platform administrator records.
REVOKE ALL PRIVILEGES ON TABLE "platform_administrators"
    FROM serviceflow_app;

GRANT SELECT ON TABLE "platform_administrators"
    TO serviceflow_app;

-- Platform grants are global identity metadata, not tenant data.
-- Runtime access is limited to the authenticated user's own grant,
-- and only when no tenant context is active.
ALTER TABLE "platform_administrators" ENABLE ROW LEVEL SECURITY;
-- The migration owner is trusted for controlled provisioning.


CREATE POLICY "platform_administrator_self_read"
    ON "platform_administrators"
    FOR SELECT
    TO serviceflow_app
    USING (
        "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    );

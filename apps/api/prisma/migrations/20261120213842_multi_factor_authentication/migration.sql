-- AlterTable
ALTER TABLE "auth_sessions" ADD COLUMN     "mfa_verified_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "user_mfa" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "encrypted_secret" BYTEA NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "last_accepted_time_step" BIGINT,
    "enabled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_mfa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_challenges" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_mfa_user_id_key" ON "user_mfa"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_id_consumed_at_idx" ON "mfa_recovery_codes"("user_id", "consumed_at");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_challenges_token_hash_key" ON "mfa_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "mfa_challenges_user_id_expires_at_idx" ON "mfa_challenges"("user_id", "expires_at");

-- AddForeignKey
ALTER TABLE "user_mfa" ADD CONSTRAINT "user_mfa_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce valid MFA configuration states and encrypted-secret payloads.
ALTER TABLE "user_mfa"
    ADD CONSTRAINT "user_mfa_status_check"
    CHECK ("status" IN ('PENDING', 'ENABLED', 'DISABLED'));

ALTER TABLE "user_mfa"
    ADD CONSTRAINT "user_mfa_enabled_at_check"
    CHECK (
        ("status" = 'PENDING' AND "enabled_at" IS NULL)
        OR ("status" = 'ENABLED' AND "enabled_at" IS NOT NULL)
        OR ("status" = 'DISABLED')
    );

ALTER TABLE "user_mfa"
    ADD CONSTRAINT "user_mfa_encrypted_secret_length_check"
    CHECK (octet_length("encrypted_secret") >= 29);

ALTER TABLE "user_mfa"
    ADD CONSTRAINT "user_mfa_time_step_check"
    CHECK ("last_accepted_time_step" IS NULL OR "last_accepted_time_step" >= 0);

-- SHA-256 hashes are stored as lowercase hexadecimal strings.
ALTER TABLE "mfa_recovery_codes"
    ADD CONSTRAINT "mfa_recovery_codes_hash_format_check"
    CHECK ("code_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "mfa_challenges"
    ADD CONSTRAINT "mfa_challenges_hash_format_check"
    CHECK ("token_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "mfa_challenges"
    ADD CONSTRAINT "mfa_challenges_expiry_check"
    CHECK ("expires_at" > "created_at");

-- Remove inherited runtime privileges, then grant only required operations.
REVOKE ALL PRIVILEGES ON TABLE "user_mfa",
    "mfa_recovery_codes",
    "mfa_challenges"
FROM serviceflow_app;

GRANT SELECT, INSERT, UPDATE ON TABLE "user_mfa"
    TO serviceflow_app;

GRANT SELECT, INSERT ON TABLE "mfa_recovery_codes"
    TO serviceflow_app;

GRANT UPDATE ("consumed_at") ON TABLE "mfa_recovery_codes"
    TO serviceflow_app;

GRANT SELECT, INSERT ON TABLE "mfa_challenges"
    TO serviceflow_app;

GRANT UPDATE ("consumed_at") ON TABLE "mfa_challenges"
    TO serviceflow_app;

-- MFA configuration is global identity data, never tenant-scoped.
ALTER TABLE "user_mfa" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_challenges" ENABLE ROW LEVEL SECURITY;

-- Users can access only their own MFA configuration, outside tenant context.
CREATE POLICY "user_mfa_self_access"
    ON "user_mfa"
    FOR ALL
    TO serviceflow_app
    USING (
        "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    )
    WITH CHECK (
        "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    );

CREATE POLICY "mfa_recovery_codes_self_access"
    ON "mfa_recovery_codes"
    FOR ALL
    TO serviceflow_app
    USING (
        "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    )
    WITH CHECK (
        "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    );

-- A challenge can be discovered by its presented token hash.
-- After discovery, consumption also requires the matching user context.
CREATE POLICY "mfa_challenges_scoped_read"
    ON "mfa_challenges"
    FOR SELECT
    TO serviceflow_app
    USING (
        NULLIF(current_setting('app.tenant_id', true), '') IS NULL
        AND (
            "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
            OR "token_hash" = NULLIF(
                current_setting('app.mfa_challenge_hash', true), ''
            )
        )
    );

CREATE POLICY "mfa_challenges_self_insert"
    ON "mfa_challenges"
    FOR INSERT
    TO serviceflow_app
    WITH CHECK (
        "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    );

CREATE POLICY "mfa_challenges_single_consumption"
    ON "mfa_challenges"
    FOR UPDATE
    TO serviceflow_app
    USING (
        "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND "token_hash" = NULLIF(
            current_setting('app.mfa_challenge_hash', true), ''
        )
        AND "consumed_at" IS NULL
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    )
    WITH CHECK (
        "user_id" = NULLIF(current_setting('app.user_id', true), '')::uuid
        AND "token_hash" = NULLIF(
            current_setting('app.mfa_challenge_hash', true), ''
        )
        AND "consumed_at" IS NOT NULL
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    );

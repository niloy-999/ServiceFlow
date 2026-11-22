-- Temporary, encrypted MFA enrollment state.
-- One pending enrollment per user; replacement does not alter active MFA.

CREATE TABLE "mfa_enrollments" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "encrypted_secret" BYTEA NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "mfa_enrollments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "mfa_enrollments_encrypted_secret_length_check"
        CHECK (octet_length("encrypted_secret") >= 29),
    CONSTRAINT "mfa_enrollments_expiry_check"
        CHECK ("expires_at" > "created_at"),
    CONSTRAINT "mfa_enrollments_user_id_fkey"
        FOREIGN KEY ("user_id") REFERENCES "users"("id")
        ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "mfa_enrollments_user_id_key"
    ON "mfa_enrollments"("user_id");

CREATE INDEX "mfa_enrollments_expires_at_idx"
    ON "mfa_enrollments"("expires_at");

-- The runtime role may read its own enrollment and create or replace
-- its encrypted pending secret, but cannot delete enrollment records.

REVOKE ALL PRIVILEGES ON TABLE "mfa_enrollments"
    FROM serviceflow_app;

GRANT SELECT ON TABLE "mfa_enrollments"
    TO serviceflow_app;

GRANT INSERT (
    "id",
    "user_id",
    "encrypted_secret",
    "expires_at",
    "updated_at"
) ON TABLE "mfa_enrollments"
    TO serviceflow_app;

GRANT UPDATE (
    "encrypted_secret",
    "expires_at",
    "updated_at"
) ON TABLE "mfa_enrollments"
    TO serviceflow_app;

-- Enrollment is global identity data, never tenant-scoped.

ALTER TABLE "mfa_enrollments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "mfa_enrollments_self_access"
    ON "mfa_enrollments"
    FOR ALL
    TO serviceflow_app
    USING (
        "user_id" = NULLIF(
            current_setting('app.user_id', true), ''
        )::uuid
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    )
    WITH CHECK (
        "user_id" = NULLIF(
            current_setting('app.user_id', true), ''
        )::uuid
        AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
    );

-- Atomically activate an enrollment.
-- The caller must already have verified the password and, when replacing
-- an enabled authenticator, the existing MFA factor.
--
-- The function itself enforces user-context ownership, active account
-- status, enrollment identity and expiry, and the MFA state transition.
-- It consumes the enrollment in the same transaction.

CREATE FUNCTION public.activate_mfa_enrollment(
    p_user_id UUID,
    p_enrollment_id UUID,
    p_last_accepted_time_step BIGINT
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_user_status VARCHAR(32);
    v_encrypted_secret BYTEA;
    v_enabled_at TIMESTAMPTZ;
BEGIN
    IF p_user_id IS NULL OR p_enrollment_id IS NULL THEN
        RAISE EXCEPTION 'MFA enrollment identifiers are required.'
            USING ERRCODE = '22023';
    END IF;

    IF p_last_accepted_time_step IS NULL
       OR p_last_accepted_time_step < 0 THEN
        RAISE EXCEPTION 'A valid TOTP time step is required.'
            USING ERRCODE = '22023';
    END IF;

    IF NULLIF(
        pg_catalog.current_setting('app.user_id', true), ''
    ) IS DISTINCT FROM p_user_id::text THEN
        RAISE EXCEPTION 'MFA enrollment user context mismatch.'
            USING ERRCODE = '42501';
    END IF;

    IF NULLIF(
        pg_catalog.current_setting('app.tenant_id', true), ''
    ) IS NOT NULL THEN
        RAISE EXCEPTION 'MFA enrollment requires global identity context.'
            USING ERRCODE = '42501';
    END IF;

    -- Serialize lifecycle operations for this account.
    SELECT u.status
      INTO v_user_status
      FROM public.users AS u
     WHERE u.id = p_user_id
     FOR UPDATE;

    IF NOT FOUND OR v_user_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'An active user is required for MFA activation.'
            USING ERRCODE = '42501';
    END IF;

    -- Lock and validate the exact pending enrollment.
    SELECT e.encrypted_secret
      INTO v_encrypted_secret
      FROM public.mfa_enrollments AS e
     WHERE e.id = p_enrollment_id
       AND e.user_id = p_user_id
       AND e.expires_at > pg_catalog.clock_timestamp()
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'MFA enrollment is missing or expired.'
            USING ERRCODE = 'P0002';
    END IF;

    v_enabled_at := pg_catalog.clock_timestamp();

    -- The runtime role cannot perform this state transition directly.
    INSERT INTO public.user_mfa (
        id,
        user_id,
        encrypted_secret,
        status,
        last_accepted_time_step,
        enabled_at,
        created_at,
        updated_at
    )
    VALUES (
        pg_catalog.gen_random_uuid(),
        p_user_id,
        v_encrypted_secret,
        'ENABLED',
        p_last_accepted_time_step,
        v_enabled_at,
        v_enabled_at,
        v_enabled_at
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
        encrypted_secret = EXCLUDED.encrypted_secret,
        status = 'ENABLED',
        last_accepted_time_step = EXCLUDED.last_accepted_time_step,
        enabled_at = EXCLUDED.enabled_at,
        updated_at = EXCLUDED.updated_at;

    DELETE FROM public.mfa_enrollments
     WHERE id = p_enrollment_id
       AND user_id = p_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'MFA enrollment could not be consumed.'
            USING ERRCODE = 'P0002';
    END IF;

    RETURN v_enabled_at;
END;
$function$;

-- Only the application runtime may invoke this narrowly scoped function.
-- It receives no direct permission to modify protected MFA state columns.

REVOKE ALL ON FUNCTION public.activate_mfa_enrollment(UUID, UUID, BIGINT)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.activate_mfa_enrollment(UUID, UUID, BIGINT)
    TO serviceflow_app;

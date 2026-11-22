CREATE OR REPLACE FUNCTION public.activate_mfa_enrollment(
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

    SELECT u.status
      INTO v_user_status
      FROM public.users AS u
     WHERE u.id = p_user_id
     FOR UPDATE;

    IF NOT FOUND OR v_user_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'An active user is required for MFA activation.'
            USING ERRCODE = '42501';
    END IF;

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

    -- Match the precision of user_mfa.enabled_at (timestamptz(3)).
    v_enabled_at := pg_catalog.date_trunc(
        'milliseconds',
        pg_catalog.clock_timestamp()
    );

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

REVOKE ALL ON FUNCTION public.activate_mfa_enrollment(UUID, UUID, BIGINT)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.activate_mfa_enrollment(UUID, UUID, BIGINT)
    TO serviceflow_app;

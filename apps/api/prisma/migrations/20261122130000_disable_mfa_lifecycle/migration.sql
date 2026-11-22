CREATE OR REPLACE FUNCTION public.disable_user_mfa(
    p_user_id UUID
)
RETURNS TABLE (
    disabled_at TIMESTAMPTZ,
    revoked_sessions INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
    v_user_status VARCHAR(32);
    v_mfa_status VARCHAR(16);
    v_disabled_at TIMESTAMPTZ;
    v_revoked_sessions INTEGER;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'MFA disable user identifier is required.'
            USING ERRCODE = '22023';
    END IF;

    IF NULLIF(
        pg_catalog.current_setting('app.user_id', true), ''
    ) IS DISTINCT FROM p_user_id::text THEN
        RAISE EXCEPTION 'MFA disable user context mismatch.'
            USING ERRCODE = '42501';
    END IF;

    IF NULLIF(
        pg_catalog.current_setting('app.tenant_id', true), ''
    ) IS NOT NULL THEN
        RAISE EXCEPTION 'MFA disable requires global identity context.'
            USING ERRCODE = '42501';
    END IF;

    SELECT u.status
      INTO v_user_status
      FROM public.users AS u
     WHERE u.id = p_user_id
     FOR UPDATE;

    IF NOT FOUND OR v_user_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'An active user is required to disable MFA.'
            USING ERRCODE = '42501';
    END IF;

    SELECT m.status
      INTO v_mfa_status
      FROM public.user_mfa AS m
     WHERE m.user_id = p_user_id
     FOR UPDATE;

    IF NOT FOUND OR v_mfa_status IS DISTINCT FROM 'ENABLED' THEN
        RAISE EXCEPTION 'MFA is not enabled for this user.'
            USING ERRCODE = 'P0002';
    END IF;

    v_disabled_at := pg_catalog.date_trunc(
        'milliseconds',
        pg_catalog.clock_timestamp()
    );

    UPDATE public.user_mfa
       SET status = 'DISABLED',
           enabled_at = NULL,
           last_accepted_time_step = NULL,
           updated_at = v_disabled_at
     WHERE user_id = p_user_id
       AND status = 'ENABLED';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'MFA configuration could not be disabled.'
            USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.mfa_recovery_codes
       SET consumed_at = v_disabled_at
     WHERE user_id = p_user_id
       AND consumed_at IS NULL;

    UPDATE public.mfa_challenges
       SET consumed_at = v_disabled_at
     WHERE user_id = p_user_id
       AND consumed_at IS NULL;

    DELETE FROM public.mfa_enrollments
     WHERE user_id = p_user_id;

    UPDATE public.auth_sessions
       SET revoked_at = v_disabled_at
     WHERE user_id = p_user_id
       AND revoked_at IS NULL;

    GET DIAGNOSTICS v_revoked_sessions = ROW_COUNT;

    RETURN QUERY
    SELECT v_disabled_at, v_revoked_sessions;
END;
$function$;

REVOKE ALL ON FUNCTION public.disable_user_mfa(UUID)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.disable_user_mfa(UUID)
    TO serviceflow_app;

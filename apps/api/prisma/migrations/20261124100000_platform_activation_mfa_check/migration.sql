-- The runtime can read MFA state only for the authenticated user. Platform
-- activation needs a single boolean for the pending initial owner; never
-- expose their secret or other MFA material to the platform operator.
CREATE FUNCTION public.is_user_mfa_enabled_for_activation(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
    SELECT COALESCE(
        NULLIF(current_setting('app.tenant_id', true), '') IS NULL
        AND p_user_id IS NOT NULL
        AND EXISTS (
            SELECT 1
            FROM public.platform_administrators AS pa
            WHERE pa.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
              AND pa.status = 'ACTIVE'
              AND pa.revoked_at IS NULL
        )
        AND EXISTS (
            SELECT 1
            FROM public.users AS u
            INNER JOIN public.user_mfa AS m ON m.user_id = u.id
            WHERE u.id = p_user_id
              AND u.status = 'ACTIVE'
              AND m.status = 'ENABLED'
              AND m.enabled_at IS NOT NULL
              AND m.enabled_at <= CURRENT_TIMESTAMP
        ),
        false
    )
$function$;

REVOKE ALL ON FUNCTION public.is_user_mfa_enabled_for_activation(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_user_mfa_enabled_for_activation(UUID) TO serviceflow_app;

-- Allow the runtime role to discover only its own memberships
-- before a tenant context has been established.

CREATE POLICY membership_self_discovery
ON tenant_memberships
FOR SELECT
TO serviceflow_app
USING (
    user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
);

# Tenant isolation and security boundaries

## Enforcement layers in current code

1. Tenant IDs are trusted only after authenticated user context and a server-side membership lookup. The tenant context service validates UUIDs, then checks active membership, user and business status in the same transaction.
2. `TenantContextService` sets `app.user_id` and `app.tenant_id` transaction-locally using parameterized SQL and invokes the callback with the transaction client. Transaction-local settings reset at transaction end, including pooled-connection reuse.
3. Global identity operations set user or MFA challenge context in a transaction and clear tenant context. Do not run RLS-protected identity queries through an unscoped root client.
4. PostgreSQL RLS policies use `current_setting(..., true)` and fail closed when context is absent. Migrations cover membership, branch, role, role-permission, membership-role, identity/MFA, platform-admin and audit tables where defined. RLS is not enabled on every table; inspect each migration when adding tables.
5. Composite tenant foreign keys prevent cross-tenant role/membership relationships independently of application checks.
6. `AuthorizationService.withPermission` checks an active tenant membership, stable code-owned permission, active branch tenant ownership and separate visibility/operation branch scopes in the same transaction as its callback. Missing business-wide scope denies unqualified operations; a browser-supplied branch ID is only a selector and never authority.
7. `membership_branch_scopes` has tenant-composite membership and branch foreign keys, uniqueness for business-wide/branch scopes, and RLS. The runtime role has no `BYPASSRLS` and is not the table owner.
8. Platform-admin policy is separate from business membership. Activation requires a validated MFA session and active platform-admin grant. The activation-only security-definer function returns a boolean for the pending initial owner's MFA enrollment; it exposes no MFA secret and is executable only by the runtime role after checking active platform-admin identity context.
9. Active business owners and administrators are included in MFA-required session creation, validation and rotation. MFA disable rejects users with an active owner/admin role. Initial activation requires the owner to have enabled MFA.

## Database roles

- `serviceflow_app`: runtime role with limited table/function grants; never use a PostgreSQL superuser for normal application access.
- `serviceflow_migrator`: schema owner/migration role; use only for migration and controlled administrative tasks.
- A local bootstrap superuser, if used by disposable infrastructure to create roles/databases, is initialization-only and must not be configured as an application or routine migration connection.

RLS policies that rely on custom GUCs are a protection against accidental query omissions, not against compromise of the shared application role: that role can set its own session context. Keep server-side authorization checks and narrowly scoped database credentials.

## Authentication and browser defenses

Sessions are opaque random tokens; only hashes are stored. Cookie settings, origin validation and CSRF checks are implemented in identity code. State-changing endpoints should remain constrained to the configured browser origin, and CSRF validation must not be bypassed to make tests pass. Platform-admin authentication is distinct from tenant membership and includes enforced MFA.

Password reset uses a random 256-bit token and stores only its SHA-256 digest. Requests are rate limited by source IP and normalized email and return the same response for unknown and eligible addresses. Confirmation is rate limited by IP and token digest, requires the configured frontend origin, and consumes the token under the user lock. Password replacement, version increment, session revocation, remaining-token invalidation and audit insertion share a transaction. The delivery integration currently supports development-only local mail files; a production provider is not configured.

## MFA and encryption

The code supports enrollment, challenges, recovery codes, disable lifecycle, encrypted TOTP secrets and versioned encryption keys. Keep encryption keys in a managed secret store in deployed environments, retain old key material only for the documented rotation window, and use the dry-run/verify modes of the rotation tool before any apply. Never log secrets or recovery codes.

## Audit

Audit events are inserted through the caller transaction. Database grants deny runtime update/delete and an immutability trigger rejects mutation. This foundation is append-only event recording, not a complete audit search/export or incident investigation system. Access to raw audit data should remain restricted.

## Required regression coverage

Run PostgreSQL integration tests for cross-tenant reads/writes, absent context, unauthorized/inactive membership, transaction-local context reuse, branch visibility versus operation scope, foreign branch IDs, and membership/business state. Also test session revocation/expiry, CSRF/origin rejection, admin/business separation, platform activation concurrency/idempotence, owner/admin MFA and disable denial, MFA challenge/recovery and encryption rotation. The 0.2 test suite currently covers tenant and branch-scope denials and platform activation lifecycle; remaining tests are tracked in the Phase 2 roadmap. Do not claim penetration testing from source review or these tests.

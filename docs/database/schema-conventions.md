# Database schema conventions

## Current schema

`apps/api/prisma/schema.prisma` currently defines 18 models and one enum. The schema covers identity, businesses and membership, access foundations, sessions and one-time tokens, rate limits, platform-administrator grants, MFA lifecycle records, and audit events. Retail, inventory, repair, payment and customer-portal domain tables are not present.

## Conventions in use

- PostgreSQL is authoritative; Prisma models map to snake_case table/column names with `@@map` and `@map`.
- UUID primary keys are used for entity tables. Link tables use composite primary keys.
- Time values use `Timestamptz(3)`; audit events have an occurrence timestamp and immutable history intent.
- Runtime and migration roles use UTC as their PostgreSQL session timezone so `Date` values and SQL time comparisons remain consistent across developer and server host timezones.
- Tenant-scoped rows carry `tenant_id`. Composite unique keys and foreign keys include tenant identity where relationships must not cross tenants (for example membership-role and role-permission links).
- Foreign keys generally use `RESTRICT` for business ownership links. Identity session/token records use explicit lifecycle and cascade/restrict choices visible in the schema.
- Important lookup and lifecycle fields have indexes; add indexes based on concrete query patterns and measured plans.
- State-like string fields are used in several models; validate transitions in application logic and add constraints when the allowed state set is stable.
- Money/stock conventions are not established because those domains do not exist yet. When implemented, use exact numeric representations and transactional ledgers per the Phase 0 specification.

## Migrations and roles

Committed migrations are forward SQL history; do not edit or delete applied migrations. Apply them with the dedicated `serviceflow_migrator` identity. The runtime identity `serviceflow_app` receives object-specific grants and RLS policies; it must not own schema objects or be a superuser. Bootstrap privileges are local/test infrastructure only and are not application credentials.

Review every migration for lock impact, constraints, grants, RLS coverage, idempotency/compatibility and rollback strategy. Prefer additive expand/contract changes. A down migration is not presumed safe for business data; recovery usually means a forward fix or a tested restore, not destructive rollback.

## Tenant rules

RLS is defense in depth. Application authorization, active membership checks, composite foreign keys and transaction-local context are all required. Tables added for tenant-owned data must receive RLS policies and explicit grants in the same reviewed migration. See [tenant isolation](../security/tenant-isolation.md).

# Database schema conventions

## Current schema

`apps/api/prisma/schema.prisma` currently defines 25 models and five enums. Alongside identity, business membership, access, session/token lifecycle, rate limits, platform-administrator grants, MFA and audit records, it now includes categories, brands, products, variants, identifiers and price history. Physical inventory, suppliers, purchasing, receiving, transfers, repair, payment and customer-portal tables remain for later 0.2 milestones or future releases.

## Conventions in use

- PostgreSQL is authoritative; Prisma models map to snake_case table/column names with `@@map` and `@map`.
- UUID primary keys are used for entity tables. Link tables use composite primary keys.
- Time values use `Timestamptz(3)`; audit events have an occurrence timestamp and immutable history intent.
- Runtime and migration roles use UTC as their PostgreSQL session timezone so `Date` values and SQL time comparisons remain consistent across developer and server host timezones.
- Tenant-scoped rows carry `tenant_id`. Composite unique keys and foreign keys include tenant identity where relationships must not cross tenants (for example membership-role and role-permission links).
- `membership_branch_scopes` uses tenant-composite membership and branch foreign keys. Partial unique indexes separately enforce one business-wide scope and one scope per branch because nullable columns do not provide the intended uniqueness semantics.
- Permission identifiers are stable strings defined by the API permission catalogue and seeded in migration history. Runtime access to the permission table is read-only; migrations own additions. Branch visibility and ability to operate are distinct persisted flags.
- Catalogue entities use tenant-composite foreign keys for tenant-owned relationships. Product variants are canonical stock identities; the database enforces a single active default variant per product at commit. Tenant SKU and identifier uniqueness is normalized and enforced by PostgreSQL.
- Catalogue prices use non-negative integer minor units and uppercase three-letter currency codes. Price history is append-only except that an open row may be closed once by setting `valid_to`; runtime access cannot delete price history.
- Catalogue records are archived rather than physically deleted through the runtime role. Product and variant edits use optimistic versions.
- Foreign keys generally use `RESTRICT` for business ownership links. Identity session/token records use explicit lifecycle and cascade/restrict choices visible in the schema.
- Important lookup and lifecycle fields have indexes; add indexes based on concrete query patterns and measured plans.
- State-like string fields are used in several models; validate transitions in application logic and add constraints when the allowed state set is stable.
- Stock quantities are not implemented yet. When implemented, use integer base units and a transactional movement ledger with balance projections per the Phase 0 specification.

## Migrations and roles

Committed migrations are forward SQL history; do not edit or delete applied migrations. Apply them with the dedicated `serviceflow_migrator` identity. The runtime identity `serviceflow_app` receives object-specific grants and RLS policies; it must not own schema objects or be a superuser. Bootstrap privileges are local/test infrastructure only and are not application credentials.

Review every migration for lock impact, constraints, grants, RLS coverage, idempotency/compatibility and rollback strategy. Prefer additive expand/contract changes. A down migration is not presumed safe for business data; recovery usually means a forward fix or a tested restore, not destructive rollback.

## Tenant rules

RLS is defense in depth. Application authorization, active membership checks, composite foreign keys and transaction-local context are all required. Tables added for tenant-owned data must receive RLS policies and explicit grants in the same reviewed migration. See [tenant isolation](../security/tenant-isolation.md).

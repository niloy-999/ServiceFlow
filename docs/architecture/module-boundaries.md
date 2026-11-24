# Module boundaries

## Implemented NestJS modules

| Module                | Owns                                                                                                                                                  | Current dependencies / limits                                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdentityModule`      | Registration, verification, password reset, login/logout, sessions, membership discovery, CSRF/origin checks, MFA lifecycle and platform-admin policy | Imports audit and rate-limit modules; uses database context services and Prisma. It currently contains multiple identity concerns because the system is still a small foundation. |
| `BusinessModule`      | Self-service business registration and MFA-protected platform-admin activation of a pending business                                                  | Activation provisions the first branch, owner role and business-wide scope atomically with audit; member and role administration is not yet implemented.                          |
| `AuthorizationModule` | Active tenant membership, stable permission-code and branch visibility/operation-scope checks in one tenant transaction                               | Code-owned permission identifiers are seeded by migration; this is an authorization foundation, not a full role-management API.                                                   |
| `AuditModule`         | Validated append-only audit event insertion in the caller's transaction                                                                               | No audit query/export UI or general event framework is implemented.                                                                                                               |
| `RateLimitModule`     | PostgreSQL-backed rate-limit counter consumption                                                                                                      | Requires a dedicated HMAC secret; storage cleanup/retention operations are not implemented.                                                                                       |
| `PrismaModule`        | Prisma client lifecycle and database access                                                                                                           | `PrismaService` uses the configured runtime `DATABASE_URL`; migration tooling separately uses `MIGRATION_DATABASE_URL`.                                                           |
| `HealthModule`        | Process liveness and database readiness endpoints                                                                                                     | `/health/live` avoids dependency checks; `/health/ready` queries PostgreSQL. The prior root health route remains a readiness alias. No orchestrator probes are configured.        |
| `CatalogueModule`     | Tenant-scoped category, brand, product, variant, identifier and price-history operations                                                              | Uses `AuthorizationService` for catalogue permissions and scopes; owns no stock balances or purchasing behavior. Mutations and audit events share one transaction.                |

## Data access and transaction scope

Use Prisma transaction callbacks for operations that need tenant or global identity context. `TenantContextService` sets `app.user_id` and `app.tenant_id` with transaction-local `set_config(..., true)`, validates active membership and business state in that transaction, then passes only the transaction client to the callback. `GlobalIdentityContextService` similarly scopes identity or MFA-challenge context and clears tenant context. Do not use a transaction client outside its callback or issue tenant-owned queries from an unscoped root Prisma client.

Audit insertion accepts the caller's transaction client so the audit record can commit or roll back with the protected operation. This is an invariant for future sensitive business actions.

## Dependency direction

HTTP controllers call their owning application services. Application services depend on identity/security services, audit insertion, and database access as required. Shared packages must not absorb domain rules or import Prisma models into the web application. Keep cross-module calls explicit through exported Nest providers; do not create speculative abstractions or a second service boundary until real reuse or deployment requirements justify it.

`main.ts` registers a global HTTP request logging interceptor. It generates request IDs and logs only safe, matched route templates and status/duration metadata. It does not log request bodies, raw path/query values, IP addresses or error messages.

## 0.2 additions and remaining boundaries

`BusinessModule` now includes an MFA-protected, platform-admin-only activation operation. Its transaction creates the first branch, activates the single eligible pending applicant, assigns system roles, grants the owner role/scope, changes business state and appends audit. The targeted security-definer function returns only an MFA-enabled boolean for that pending owner to an active platform administrator; it does not expose the user's MFA secret.

The authorization foundation has tenant-consistent branch scope rows, with branch visibility separated from operation scope. `AuthorizationService.withPermission` combines membership/business status, registered permission, active branch ownership and branch scope checks in the same transaction as its callback. Active business owners and administrators require MFA for sessions and cannot disable it. Platform administration remains a separate identity grant.

The catalogue module now offers category, brand, product and variant create/list/edit/archive workflows. Variants are canonical stock identity; product kinds do not create separate stock pools. Serial tracking is a product setting only: serialized unit records and lifecycle are not implemented yet. Price history uses integer minor units and is immutable except for closing an open interval.

There is still no role/membership administration UI/API, inventory ledger/balances, supplier/purchasing/receiving/returns, transfer service, worker, outbox, object-storage adapter, payment provider, POS, repair or customer-portal workflow, or business audit reader. The code-owned permissions presently cover the planned 0.2 capabilities. Browser E2E workflows for the catalogue are pending the release acceptance milestone.

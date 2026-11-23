# Module boundaries

## Implemented NestJS modules

| Module            | Owns                                                                                                                                                  | Current dependencies / limits                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdentityModule`  | Registration, verification, password reset, login/logout, sessions, membership discovery, CSRF/origin checks, MFA lifecycle and platform-admin policy | Imports audit and rate-limit modules; uses database context services and Prisma. It currently contains multiple identity concerns because the system is still a small foundation. |
| `BusinessModule`  | Self-service business registration and its membership/audit effects                                                                                   | Imports identity and audit modules. It does not implement tenant operations or business approval workflows beyond current source behavior.                                        |
| `AuditModule`     | Validated append-only audit event insertion in the caller's transaction                                                                               | No audit query/export UI or general event framework is implemented.                                                                                                               |
| `RateLimitModule` | PostgreSQL-backed rate-limit counter consumption                                                                                                      | Requires a dedicated HMAC secret; storage cleanup/retention operations are not implemented.                                                                                       |
| `PrismaModule`    | Prisma client lifecycle and database access                                                                                                           | `PrismaService` uses the configured runtime `DATABASE_URL`; migration tooling separately uses `MIGRATION_DATABASE_URL`.                                                           |
| `HealthModule`    | Database connectivity health endpoint                                                                                                                 | Current response is a DB-backed health check; separate liveness/readiness endpoints are not implemented.                                                                          |

## Data access and transaction scope

Use Prisma transaction callbacks for operations that need tenant or global identity context. `TenantContextService` sets `app.user_id` and `app.tenant_id` with transaction-local `set_config(..., true)`, validates active membership and business state in that transaction, then passes only the transaction client to the callback. `GlobalIdentityContextService` similarly scopes identity or MFA-challenge context and clears tenant context. Do not use a transaction client outside its callback or issue tenant-owned queries from an unscoped root Prisma client.

Audit insertion accepts the caller's transaction client so the audit record can commit or roll back with the protected operation. This is an invariant for future sensitive business actions.

## Dependency direction

HTTP controllers call their owning application services. Application services depend on identity/security services, audit insertion, and database access as required. Shared packages must not absorb domain rules or import Prisma models into the web application. Keep cross-module calls explicit through exported Nest providers; do not create speculative abstractions or a second service boundary until real reuse or deployment requirements justify it.

## Boundaries not yet implemented

There is no standalone authorization/permission enforcement module, branch-scope engine, worker, outbox, object-storage adapter, payment provider, POS, inventory, repair, customer portal workflow, or business audit reader. The current role and permission schema is foundation data, not evidence that a complete RBAC product exists.

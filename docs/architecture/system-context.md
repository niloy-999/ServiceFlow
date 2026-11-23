# System context

## Current system

ServiceFlow is a single repository with a Next.js web application and a NestJS API. The API is a modular monolith backed by PostgreSQL through Prisma and `@prisma/adapter-pg`. The web application is currently an application shell; the API owns identity, sessions, email verification and password reset, tenant membership discovery, business registration, platform-administrator checks, MFA, rate limiting, audit-event insertion, and a database health endpoint.

The actual API modules are `IdentityModule`, `BusinessModule`, `AuditModule`, `RateLimitModule`, `PrismaModule`, and `HealthModule`. The workspace also contains worker, contracts, and tooling packages, but they do not currently implement background processing, shared domain contracts, or substantive shared tooling. There is no production deployment or external provider integration established by the repository.

## External actors and trust boundaries

- A browser calls the API over HTTP. The API uses a configured `WEB_APP_URL`, credentialed CORS, origin validation, CSRF tokens on state-changing session-authenticated requests, and secure session-cookie policy.
- The API authenticates an opaque session by looking up a hash in PostgreSQL. Raw session tokens are not persisted.
- Authenticated business operations establish user and tenant context in a Prisma transaction. Active membership and active tenant state are verified server-side before tenant-scoped work.
- PostgreSQL RLS is an additional enforcement boundary for selected tenant and identity tables. SQL migrations also set role grants and append-only audit restrictions.
- Platform-administrator authorization is a distinct identity-level policy; membership in a business does not confer platform authority.
- Email delivery is represented by an adapter with a local development mode. A production provider is not configured here.

## Current data ownership

The Prisma schema contains 18 models and one enum: user and business identity; membership, branches, roles and permissions; sessions and verification/reset tokens; rate-limit buckets; platform-administrator grants; MFA enrollment/challenge/recovery; and audit events. Tenant-owned business capability domains such as products, stock, sales and repairs do not yet exist.

Password reset uses one-use, 30-minute opaque tokens stored as SHA-256 hashes. Successful completion changes the password, increments the user version, revokes existing sessions and consumes outstanding reset tokens in one transaction. Unknown, expired and consumed tokens receive the same completion response.

## Runtime and operations

The API starts at `/api/v1`; `/api/v1/health/live` reports process liveness without querying dependencies, and `/api/v1/health/ready` performs a PostgreSQL query. `/api/v1/health` remains a readiness alias. A global interceptor generates an `X-Request-Id` response header and structured HTTP logs with route-template and error-message redaction. The listener defaults to `127.0.0.1`. PostgreSQL is expected to be private and the local development setup binds only to loopback. A local custom-format backup/restore drill is implemented and verified; production deployment, production backup configuration, external monitoring/alerting, and independent penetration testing are not evidenced. See [operational readiness](../operations/operational-readiness.md).

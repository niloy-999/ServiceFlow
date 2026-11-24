# Testing strategy

## Test layers

- **Formatting:** Prettier check across tracked source/docs. No ESLint configuration currently exists.
- **TypeScript:** shared strict options, API `tsc` and web `tsc`.
- **Unit tests:** Node's built-in test runner against compiled API output. These cover password handling, CSRF/origin, cookies, session guard, MFA crypto/key rotation, runtime configuration/log redaction, and other isolated logic.
- **PostgreSQL integration tests:** Node test runner and real PostgreSQL, with an application connection and separate migration/fixture connection. SQLite is not an acceptable substitute for RLS, grants, transaction-local context, PostgreSQL functions or constraints.
- **Builds:** API Prisma generation/TypeScript compilation and Next.js production build.
- **Operations-focused unit coverage:** liveness/readiness dependency behavior, request correlation and log redaction, and the local email adapter's provider boundary and filesystem permissions.

## Commands

From repository root, use `./scripts/pnpm.sh` so Corepack selects the repository-pinned pnpm version:

```sh
./scripts/pnpm.sh format:check
./scripts/pnpm.sh typecheck
./scripts/pnpm.sh test:unit
./scripts/pnpm.sh test:integration
./scripts/pnpm.sh build
```

`test:integration` compiles the API and executes `apps/api/test/*.integration.mjs`. It requires explicit isolated `serviceflow_test` runtime and migration URLs, `WEB_APP_URL`, CSRF/rate-limit secrets, and MFA key configuration as exercised by each suite. Apply committed migrations to the isolated test DB before running it. Never point integration tests at an existing user, staging, or production database. Tests may create and remove fixtures; do not add broad database reset/drop behavior.

Identity integration coverage includes registration and email verification, password reset expiry/single-use/session revocation, session lifecycle, MFA challenges/recovery, rate limits, and tenant RLS. Password reset assertions verify that only token hashes are persisted and that invalid or consumed links have generic responses.

Phase 2 adds PostgreSQL-backed platform activation and RBAC/branch-scope tests. Activation covers pending-state rejection, MFA-authenticated platform activation, single initial owner and branch, atomic audit, and replay rejection. Authorization tests cover known permission identifiers, active business/member state, cross-tenant branches, business-wide vs branch visibility, and view vs operation scope. Catalogue integration coverage exercises CRUD, default variants, normalized tenant uniqueness, price history immutability, auditing, malformed DTO rejection, cross-tenant denial, and the PostgreSQL default-variant constraint. Browser E2E workflows for catalogue remain pending. Inventory, receiving, returns and transfer mutations require real PostgreSQL concurrency, idempotency, ledger/projection and audit tests; do not simulate these invariants with SQLite or in-memory mocks alone.

The root `ci:check` aggregates formatting, typechecking, unit tests, and builds. It does not imply PostgreSQL integration tests passed. CI runs those separately against an ephemeral service.

For a local PostgreSQL backup/restore drill, use the procedures in [operational readiness](../operations/operational-readiness.md). The drill must use an isolated source and newly generated restore database; never point it at production or reuse an existing target.

## Security-focused test gates

- RLS isolation between at least two tenants; no-context and unauthorized context cases.
- Transaction-local user/tenant settings do not leak through pooled connections.
- Registration, verification, login, logout, session expiry/revocation and rate limiting.
- Origin and CSRF validation for state-changing requests.
- Platform admin separation, activation authority and enforced MFA for platform and business owners/administrators.
- Tenant permission checks and separate branch visibility/operation scopes.
- MFA enrollment, challenge single consumption, recovery, disable, key rotation.
- Append-only audit grants and transactional insertion.
- Migration apply and status on a fresh isolated PostgreSQL database.

## Limits and future layers

There are no browser E2E, load/concurrency, accessibility automation, or disaster-recovery tests in the current foundation. Add them when corresponding product workflows and environments exist. Test results are only reported as passing when the command actually ran successfully. This strategy is not an independent security assessment.

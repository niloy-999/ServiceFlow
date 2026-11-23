# ServiceFlow Phase 1 — Extended Implementation Roadmap

**Authority:** The original Phase 0 specification at `docs/architecture/SERVICEFLOW_PHASE_0_SPECIFICATION.md` defines Steps 1.1–1.7 only. The later milestones below are reconstructed from repository history, source, migrations and tests; they are not attributed to the original specification.

**Status vocabulary:** `Verified` means repository evidence or an observed successful command supports completion. `Partial` means implementation exists but an acceptance area remains. `Missing` means no material implementation was found. `Execution-unverified` means source exists but the required runtime check has not been observed. No status implies production deployment, independent security assessment or successful recovery drill.

## Baseline evidence

- Branch `main` was clean at `e46ecc6` (`feat(api): add versioned MFA encryption key rotation`) and matched `origin/main` when work began.
- Git history records workspace/tooling setup, Next.js and NestJS bootstrap, PostgreSQL/Prisma, RLS, tenant membership, identity, sessions, registration, rate limiting, membership discovery, business registration, platform administration, MFA lifecycle/enforcement and key rotation.
- The actual Prisma schema contains **18 models and one enum**. This is schema evidence, not a claim about deployed database state.
- An existing `apps/api/.env` was observed by existence only. Its contents were not read. No credentials were printed or committed.

## Original Phase 1 steps (preserved)

| Step                                           | Objective                                                                                                   | Status and evidence                                                                                                                                                                                                                                                                            | Remaining acceptance                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1.1 Local environment and repository preflight | Confirm directory, runtime, package manager, Docker and GitHub access without overwriting existing state.   | Partial: clean `main`, Node `24.10.0`, project-local Corepack pnpm `10.34.9`, Git history/remotes and PostgreSQL 17.12 tools verified. Docker is unavailable. Existing API `.env` presence was observed without reading contents.                                                              | Verify Docker capability through CI or a Docker-capable host. Keep environment contents private. |
| 1.2 Monorepo                                   | pnpm workspace, strict shared TS, formatting/lint strategy, README, ignore rules and reproducible installs. | Partial: frozen-lockfile install and root format/typecheck/unit/build commands passed. No ESLint tool was established, so formatting and TypeScript are the static checks.                                                                                                                     | Clean-clone install evidence remains. No lint command is claimed.                                |
| 1.3 Applications                               | Independently runnable Next.js and NestJS applications, health, API prefix and validated config.            | Partial: API and web production builds/typechecks passed; API health and `/api/v1` exist; host/port validation and unit coverage were added.                                                                                                                                                   | Live API startup/health smoke test remains.                                                      |
| 1.4 PostgreSQL                                 | Private local PostgreSQL, Prisma migrations, app/migration role separation and isolated test database.      | Partial: Compose/init infrastructure binds loopback and provisions distinct roles/databases with UTC session settings. Fresh temporary PostgreSQL 17.12 cluster applied all migrations and passed all integration tests. Compose itself is execution-unverified because Docker is unavailable. | Verify Compose startup and volume ownership guard where Docker is available.                     |
| 1.5 CI                                         | Lockfile install, quality checks, builds, Postgres integration migrations/tests and secret scanning.        | Partial: workflow implemented with isolated PostgreSQL service and Gitleaks; GitHub Actions has not yet run.                                                                                                                                                                                   | Confirm workflow jobs after push; no remote branch-protection changes.                           |
| 1.6 Architecture docs                          | Required context, boundaries, modular-monolith ADR, schema, tenant security and test strategy docs.         | Verified: all six required documents now describe source and limitations.                                                                                                                                                                                                                      | Revisit as modules evolve.                                                                       |
| 1.7 Acceptance                                 | Reproducible clean checkout, apps, database, CI and secret exclusion.                                       | Partial: formatting, TS, 65 unit tests, API/web builds, fresh migrations and 77 PostgreSQL integration tests passed locally.                                                                                                                                                                   | Clean-clone and remote CI evidence remain.                                                       |

## Reconstructed implementation milestones

These milestones are based on repository evidence, not the Phase 0 specification's numbered steps.

### R1 — Toolchain and quality orchestration

**Status:** Verified locally. **Objective:** Make workspace install, formatting, typecheck, test and build commands consistent across current packages. **Dependencies:** Steps 1.1–1.2.

**Acceptance:** Frozen-lockfile install succeeds; shared TypeScript settings are coherent; root scripts cover actual unit/integration tests and application builds; README commands match scripts. No empty lint abstractions are added. The repository has no ESLint setup, so no lint command is claimed.

**Verify:** `./scripts/pnpm.sh install --frozen-lockfile`, `./scripts/pnpm.sh format:check`, `./scripts/pnpm.sh typecheck`, `./scripts/pnpm.sh test:unit`, `./scripts/pnpm.sh build`.

### R2 — Local PostgreSQL and isolated integration database

**Status:** Partial. **Objective:** Reproduce PostgreSQL locally and in CI without public exposure, unintended database reuse/destruction, or a superuser as the normal application identity. **Dependencies:** R1 and review of database configuration.

**Acceptance:** Local DB binds loopback; credentials stay in ignored local configuration; runtime and migration roles are distinct non-superusers with least privilege; dev/test/shadow DBs are separate; integration tests refuse non-test DB names; role session timezones are UTC; migrations apply to a fresh isolated database; the local helper refuses a volume without its matching project ownership marker.

**Verify:** `./scripts/local-postgres.sh up`, `./scripts/pnpm.sh --filter @serviceflow/api db:migrate:deploy`, `./scripts/pnpm.sh --filter @serviceflow/api db:migrate:status`, `./scripts/pnpm.sh --filter @serviceflow/api test:integration`. Integration URLs must target `serviceflow_test`; no destructive database commands.

### R3 — Identity, tenant and MFA security review

**Status:** Verified for the implemented foundation through source review and local PostgreSQL tests, including password-reset lifecycle. This is not an independent penetration test. **Objective:** Review identity/session/CSRF/origin, tenant context/RLS, platform-admin separation, MFA recovery/disable, encryption rotation, audit access, grants and constraints; fix confirmed defects with regression coverage. **Dependencies:** R2.

**Acceptance:** Tenant context is transaction-local and safe across pooled connections; tests cover cross-tenant reads/writes and missing/unauthorized context; session, CSRF/origin, platform-admin, MFA lifecycle/recovery and key rotation behavior are covered; audit insertion is transactional and mutation restricted by grants/trigger. No penetration-test claim.

**Verify:** `./scripts/pnpm.sh --filter @serviceflow/api test:unit`, `./scripts/pnpm.sh --filter @serviceflow/api db:migrate:deploy`, `./scripts/pnpm.sh --filter @serviceflow/api db:migrate:status`, `./scripts/pnpm.sh --filter @serviceflow/api test:integration`.

### R4 — CI and supply-chain checks

**Status:** Implemented; GitHub execution-unverified. **Objective:** Run quality, builds, unit tests, isolated PostgreSQL integration/migrations and secret scanning on GitHub Actions. **Dependencies:** R1–R3.

**Acceptance:** Uses committed lockfile; Postgres service and databases are job-isolated; tests do not connect to external/local databases; failure logs are useful; Gitleaks scans repository history with full redaction; workflow does not alter repository settings.

**Verify:** `actionlint .github/workflows/ci.yml` when available; `./scripts/pnpm.sh ci:check`; inspect the GitHub Actions result after push. The integration job separately applies migrations and runs `test:integration`.

### R5 — Architecture and security documentation

**Status:** Verified. **Objective:** Add system context, module boundaries, modular-monolith ADR, schema conventions, tenant isolation and testing strategy. **Dependencies:** R3 source review.

**Acceptance:** Documents actual modules, 18-model/one-enum schema, transaction and RLS assumptions, trust boundaries, current test gaps and deferred capabilities.

**Verify:** `./scripts/pnpm.sh format:check`; cross-check claims against `apps/api/src`, Prisma schema/migrations, tests and manifests.

### R6 — Operational readiness foundation

**Status:** Partial. **Objective:** Assess configuration validation, structured logging, error handling, health/readiness, backup/restore, migration/rollback safety, deployment and incident/monitoring expectations. **Dependencies:** R2–R5.

**Acceptance:** Implement appropriate configuration/code gaps; document backup/restore expectations without claiming drills; distinguish implemented health from future readiness/monitoring; state deployment and incident gates. Current work adds a redacting JSON logger and validated API host/port. Production log aggregation/metrics, backup, restore drill and incident exercise remain absent.

**Verify:** `./scripts/pnpm.sh ci:check` and manual review of `docs/operations/operational-readiness.md`. No production deployment or recovery-drill claim without evidence.

### R7 — Final reproducibility and acceptance

**Status:** Partial. **Objective:** Demonstrate safe setup and all feasible Phase 1 checks; record blocked checks precisely. **Dependencies:** R1–R6.

**Acceptance:** README setup is verified on a clean clone; format, TS, unit, builds, migrations, PostgreSQL integration, tenant isolation, authentication and MFA checks have actual passing evidence; GitHub CI is functional; completed commits are on existing `main`; final tree is clean. Unavailable requirements remain explicitly unverified.

**Verify:** `./scripts/pnpm.sh ci:check`, isolated PostgreSQL commands from R2/R3, `git diff --check`, `git status --short --branch`, `git log --oneline -n 10`.

### R8 — Password reset lifecycle

**Status:** Verified locally. **Objective:** Complete the single-use expiring password reset flow required by Phase 0 identity scope, using the existing schema table and security controls. **Dependencies:** R2, R3.

**Acceptance:** Generic request and confirmation responses; origin validation and IP/email/token rate limits; only SHA-256 token digests stored; locked, transactional one-use expiry validation; successful reset replaces password, increments user version, revokes sessions, consumes outstanding reset tokens, and records an audit event. Tests cover unknown, valid, consumed, expired and HTTP origin/rate-limit behavior.

**Verify:** `./scripts/pnpm.sh --filter @serviceflow/api test:auth-registration` against isolated migrated `serviceflow_test`, then the full integration suite and `./scripts/pnpm.sh ci:check`.

## Scope boundary

Phase 1 establishes a secure, reproducible foundation. POS, inventory, repair management, payments, AI workflows and customer portal workflows remain out of scope. Their absence is intentional and is not a Phase 1 defect.

## Progress log

- Roadmap drafted from baseline commit `e46ecc6`.
- Implemented root quality scripts, API host/port validation, local PostgreSQL provisioning, isolated database guards, CI, architecture/security/testing/operations documents, and source-backed roadmap updates.
- Updated integration database guards to require `serviceflow_test` instead of the development database. Set runtime and migration role timezones to UTC. Fresh PostgreSQL 17.12 migrations/status and all 77 integration tests pass with the host timezone set to Asia/Dhaka.
- Local `ci:check` passed after password-reset implementation: formatting, TypeScript, 65 unit tests and API/web production builds.
- Fresh isolated PostgreSQL 17.12 databases applied all 18 migrations; all 77 integration tests passed, including password-reset token hashing, generic behavior, expiry/replay rejection, session revocation, origin checks, and rate limits.
- Source review found the Phase 0-required password-reset token model had no service or route. Added the bounded identity flow with generic responses, throttling, origin validation, transactional audit/session revocation, and integration coverage.
- GitHub Actions execution, Docker Compose startup, clean-clone setup and final Git publication remain outstanding.

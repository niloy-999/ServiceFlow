# ServiceFlow Phase 1 — Extended Implementation Roadmap

**Authority:** The original Phase 0 specification at `docs/architecture/SERVICEFLOW_PHASE_0_SPECIFICATION.md` defines Steps 1.1–1.7 only. The later milestones below are reconstructed from repository history, source, migrations and tests; they are not attributed to the original specification.

**Status vocabulary:** `Verified` means repository evidence or an observed successful command supports completion. `Partial` means implementation exists but an acceptance area remains. `Missing` means no material implementation was found. `Execution-unverified` means source exists but the required runtime check has not been observed. No status implies production deployment, independent security assessment or successful recovery drill.

## Baseline evidence

- Branch `main` was clean at `4f60233` when this operational follow-up began and matched `origin/main`.
- Git history records workspace/tooling setup, Next.js and NestJS bootstrap, PostgreSQL/Prisma, RLS, tenant membership, identity, sessions, registration, rate limiting, membership discovery, business registration, platform administration, MFA lifecycle/enforcement and key rotation.
- The actual Prisma schema contains **18 models and one enum**. This is schema evidence, not a claim about deployed database state.
- An existing `apps/api/.env` was observed by existence only. Its contents were not read or modified. Root `.env.local` was absent and created exclusively with local random values; it and `.local` remain ignored. No credentials were printed or committed.

## Original Phase 1 steps (preserved)

| Step                                           | Objective                                                                                                   | Status and evidence                                                                                                                                                                                                                                                          | Remaining acceptance                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1.1 Local environment and repository preflight | Confirm directory, runtime, package manager, Docker and GitHub access without overwriting existing state.   | Verified locally: Node `24.10.0`, pnpm `10.34.9`, Docker Desktop and arm64 PostgreSQL `17.12` verified. Existing API `.env` presence observed without reading contents.                                                                                                      | Keep local environment contents private.                    |
| 1.2 Monorepo                                   | pnpm workspace, strict shared TS, formatting/lint strategy, README, ignore rules and reproducible installs. | Verified: clean GitHub checkout installed from the committed lockfile; root format/typecheck/unit/build commands passed. No ESLint tool was established, so formatting and TypeScript are the static checks.                                                                 | No lint command is claimed.                                 |
| 1.3 Applications                               | Independently runnable Next.js and NestJS applications, health, API prefix and validated config.            | Verified locally: API/web production builds and typechecks; liveness/readiness, `/api/v1`, validated config, request correlation and HTTP log sanitization. Live API smoke checked readiness and unique correlation IDs.                                                     | No production deployment is implied.                        |
| 1.4 PostgreSQL                                 | Private local PostgreSQL, Prisma migrations, app/migration role separation and isolated test database.      | Verified locally: Compose binds loopback; new guarded volume healthy with 1 GiB/1.5 CPU caps; dev/test/shadow DBs and roles provisioned; app role is not superuser/BYPASSRLS and cannot connect to shadow; all 18 migrations applied to dev/test; 77 integration tests pass. | Re-run on clean machine as needed.                          |
| 1.5 CI                                         | Lockfile install, quality checks, builds, Postgres integration migrations/tests and secret scanning.        | Verified: GitHub Actions run [45248882328](https://github.com/niloy-999/ServiceFlow/actions/runs/45248882328) passed frozen install, format, TypeScript, 74 unit tests, API/web builds, all 18 migrations, 77 PostgreSQL integration tests and Gitleaks.                     | Keep workflow current; no remote branch-protection changes. |
| 1.6 Architecture docs                          | Required context, boundaries, modular-monolith ADR, schema, tenant security and test strategy docs.         | Verified: all six required documents now describe source and limitations.                                                                                                                                                                                                    | Revisit as modules evolve.                                  |
| 1.7 Acceptance                                 | Reproducible clean checkout, apps, database, CI and secret exclusion.                                       | Verified: local Compose, migrations, integration suite, recovery drill, local quality/build checks, and hosted CI/secret scanning passed. No production deployment or independent penetration test is claimed.                                                               | Production-only gates remain out of Phase 1.                |

## Reconstructed implementation milestones

These milestones are based on repository evidence, not the Phase 0 specification's numbered steps.

### R1 — Toolchain and quality orchestration

**Status:** Verified locally. **Objective:** Make workspace install, formatting, typecheck, test and build commands consistent across current packages. **Dependencies:** Steps 1.1–1.2.

**Acceptance:** Frozen-lockfile install succeeds; shared TypeScript settings are coherent; root scripts cover actual unit/integration tests and application builds; README commands match scripts. No empty lint abstractions are added. The repository has no ESLint setup, so no lint command is claimed.

**Verify:** `./scripts/pnpm.sh install --frozen-lockfile`, `./scripts/pnpm.sh format:check`, `./scripts/pnpm.sh typecheck`, `./scripts/pnpm.sh test:unit`, `./scripts/pnpm.sh build`.

### R2 — Local PostgreSQL and isolated integration database

**Status:** Verified for local Compose and migrations. **Objective:** Reproduce PostgreSQL locally and in CI without public exposure, unintended database reuse/destruction, or a superuser as the normal application identity. **Dependencies:** R1 and review of database configuration.

**Acceptance:** Local DB binds loopback; credentials stay in ignored local configuration; runtime and migration roles are distinct non-superusers with least privilege; dev/test/shadow DBs are separate; integration tests refuse non-test DB names; role session timezones are UTC; migrations apply to a fresh isolated database; the local helper refuses a volume without its matching project ownership marker.

**Verify:** `./scripts/local-postgres.sh up`, `./scripts/pnpm.sh --filter @serviceflow/api db:migrate:deploy`, `./scripts/pnpm.sh --filter @serviceflow/api db:migrate:status`, `./scripts/pnpm.sh --filter @serviceflow/api test:integration`. Integration URLs must target `serviceflow_test`; no destructive database commands.

### R3 — Identity, tenant and MFA security review

**Status:** Verified for the implemented foundation through source review and local PostgreSQL tests, including password-reset lifecycle. This is not an independent penetration test. **Objective:** Review identity/session/CSRF/origin, tenant context/RLS, platform-admin separation, MFA recovery/disable, encryption rotation, audit access, grants and constraints; fix confirmed defects with regression coverage. **Dependencies:** R2.

**Acceptance:** Tenant context is transaction-local and safe across pooled connections; tests cover cross-tenant reads/writes and missing/unauthorized context; session, CSRF/origin, platform-admin, MFA lifecycle/recovery and key rotation behavior are covered; audit insertion is transactional and mutation restricted by grants/trigger. No penetration-test claim.

**Verify:** `./scripts/pnpm.sh --filter @serviceflow/api test:unit`, `./scripts/pnpm.sh --filter @serviceflow/api db:migrate:deploy`, `./scripts/pnpm.sh --filter @serviceflow/api db:migrate:status`, `./scripts/pnpm.sh --filter @serviceflow/api test:integration`.

### R4 — CI and supply-chain checks

**Status:** Verified in GitHub Actions. **Objective:** Run quality, builds, unit tests, isolated PostgreSQL integration/migrations and secret scanning on GitHub Actions. **Dependencies:** R1–R3.

**Acceptance:** Uses committed lockfile; Postgres service and databases are job-isolated; tests do not connect to external/local databases; failure logs are useful; Gitleaks scans repository history with full redaction; workflow does not alter repository settings.

**Verify:** `actionlint .github/workflows/ci.yml` when available; `./scripts/pnpm.sh ci:check`; [GitHub Actions run 45248882328](https://github.com/niloy-999/ServiceFlow/actions/runs/45248882328). The integration job applied migrations and ran `test:integration` against its isolated PostgreSQL service. An earlier run exposed stale SQL paths after file relocation; this was corrected and the passing run verifies the committed layout.

### R5 — Architecture and security documentation

**Status:** Verified. **Objective:** Add system context, module boundaries, modular-monolith ADR, schema conventions, tenant isolation and testing strategy. **Dependencies:** R3 source review.

**Acceptance:** Documents actual modules, 18-model/one-enum schema, transaction and RLS assumptions, trust boundaries, current test gaps and deferred capabilities.

**Verify:** `./scripts/pnpm.sh format:check`; cross-check claims against `apps/api/src`, Prisma schema/migrations, tests and manifests.

### R6 — Operational readiness foundation

**Status:** Partial. **Objective:** Assess configuration validation, structured logging, error handling, health/readiness, backup/restore, migration/rollback safety, deployment and incident/monitoring expectations. **Dependencies:** R2–R5.

**Acceptance:** Implement appropriate configuration/code gaps; document backup/restore expectations and evidence; distinguish implemented health from future probes/monitoring; state deployment and incident gates. Request IDs, structured HTTP logging, live/ready checks, redaction tests and a local custom-format recovery tool exist. Local restore and generated-target cleanup verified. External aggregation/metrics, production backups and incident exercise remain absent.

**Verify:** `./scripts/pnpm.sh ci:check`, local PostgreSQL migration/integration and restore-drill commands; manual review of `docs/operations/operational-readiness.md`. No production deployment claim.

### R7 — Final reproducibility and acceptance

**Status:** Verified for Phase 1 scope. **Objective:** Demonstrate safe setup and all feasible Phase 1 checks; record deferred work precisely. **Dependencies:** R1–R6.

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
- GitHub Actions run 45166888023 passed all three jobs on `main`, confirming frozen install, formatting, TypeScript, 65 unit tests, API/web builds, fresh PostgreSQL migrations, all 77 integration tests and Gitleaks history scanning. Earlier runs exposed a missing pnpm PATH assumption, numeric YAML coercion of test secrets, template-placeholder false positives and a race-test assertion; each was corrected.
- Docker Compose is running locally on Docker Desktop arm64 using the ownership-marked volume. The SQL relocation fix was preserved and corrected for the official image's `POSTGRES_PASSWORD` variable; database health executes a query on `serviceflow_dev`. All 18 migrations applied to dev and test. Runtime role checks verified restricted attributes, grants, UTC settings and no shadow/bootstrap connect access. A safe stop/up persistence check retained all 18 migration records.
- 77 integration tests passed against isolated `serviceflow_test`. Unit suite now passes 74 tests including health probes, request correlation/redaction, local mail modes, fail-closed provider configuration and local volume-helper safety.
- Local custom-format backup exists outside the repository at `/private/tmp/serviceflow-phase1-local-test.dump`, mode 0600. Three generated restore targets were verified for 18 migrations, representative data, foreign keys, grants, RLS, ownership, runtime restrictions, no-context tenant reads and Prisma migration status. All were removed after identity and connection checks; source databases and the volume remain.
- The API has a local mail-file adapter only. Production provider, monitoring, alerting, independent penetration testing, deployment, production backups and recovery goals remain release gates.
- Final GitHub Actions run [45248882328](https://github.com/niloy-999/ServiceFlow/actions/runs/45248882328) passed on commit `ca824b2`: lockfile install, formatting, TypeScript, 74 unit tests, API/web builds, PostgreSQL SQL initialization, all 18 migrations, 77 integration tests and Gitleaks. The first run for `a30598e` caught the stale SQL paths and failed; the workflow fix was committed and its run passed.

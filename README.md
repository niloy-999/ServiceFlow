# ServiceFlow

ServiceFlow is an early-stage multi-tenant SaaS platform for computer retail shops and repair/service centres. The current 0.2 release work includes identity/business onboarding and the tenant-scoped product catalogue. Branch inventory, purchasing, transfers, POS, repair workflows, payments, AI, and customer portal workflows are not implemented yet.

## Technology

- Node.js `24.10.0`, pnpm `10.34.9` through Corepack
- Next.js and React in `apps/web`
- NestJS modular monolith in `apps/api`
- PostgreSQL and Prisma migrations in `apps/api/prisma`
- Shared strict TypeScript settings and Prettier formatting

There is no ESLint configuration today. Formatting, TypeScript, tests, and builds are the configured quality gates; do not interpret the absence of a lint command as a passing lint run.

## Prerequisites

- Node.js `24.10.0`
- Corepack
- Docker Compose v2 for local PostgreSQL (not required for unit tests)

Verify the runtime and package manager from the repository root:

```sh
./scripts/pnpm.sh check:runtime
./scripts/pnpm.sh --version
```

Install the exact committed workspace dependency graph:

```sh
./scripts/pnpm.sh install --frozen-lockfile
```

## Local PostgreSQL

The local Compose configuration is opt-in and binds PostgreSQL to loopback only. It uses conservative 1 GiB/1.5 CPU limits and creates separate bootstrap, migration, and runtime roles and separate development, test, and shadow databases. Runtime and migration roles use UTC session time. Bootstrap credentials are only used during initialization; the API must use the restricted runtime role and Prisma migrations must use the migration role.

1. Review `.env.local.example` (it contains placeholders, not usable credentials).
2. Create `.env.local` only if it does not already exist, then replace every placeholder with unique local credentials. Never copy over an existing environment file.
3. Create `apps/api/.env` from the same template only if it does not already exist, then make its database URLs match `.env.local`. Nest and Prisma load this API-local file through the existing dotenv configuration. Keep both files private.
4. Start the local database:

```sh
test ! -e .env.local && cp .env.local.example .env.local
test ! -e apps/api/.env && cp .env.local.example apps/api/.env
./scripts/local-postgres.sh up
```

The copy commands intentionally fail when the destination already exists. The helper validates Compose configuration and refuses to reuse any pre-existing volume without its own matching identity marker in ignored `.local/` state. Do not publish the database port or use the bootstrap account from the application. To stop the service without deleting its data, run `./scripts/local-postgres.sh stop`; never use volume-removal options for this project database.

Set the API/test process environment using the values in `.env.local` (do not commit or paste the file). `DATABASE_URL` must target `serviceflow_dev` with `serviceflow_app`; `MIGRATION_DATABASE_URL` must target `serviceflow_dev` with `serviceflow_migrator`; `SHADOW_DATABASE_URL` must target the dedicated `serviceflow_shadow` database. Integration tests use `serviceflow_test` with the matching runtime and migration URLs. Use development-only CSRF, rate-limit and MFA keys. Email delivery should be set to the local development adapter.

Apply migrations to the selected development database:

```sh
./scripts/pnpm.sh --filter @serviceflow/api db:migrate:deploy
./scripts/pnpm.sh --filter @serviceflow/api db:migrate:status
```

The integration test database is separate. Before integration tests, set `DATABASE_URL` and `MIGRATION_DATABASE_URL` in the test process to the `serviceflow_test` URLs (the migration role owns that database), then apply migrations. Tests create and remove their own uniquely named fixtures; they must not be pointed at a personal or production database.

## Development and verification

```sh
./scripts/pnpm.sh --filter @serviceflow/web dev
./scripts/pnpm.sh --filter @serviceflow/api start
```

The API requires its documented environment values and a migrated PostgreSQL database. `/api/v1/health/live` checks process liveness without PostgreSQL; `/api/v1/health/ready` checks PostgreSQL connectivity. `/api/v1/health` remains a readiness alias. HTTP requests receive a generated `X-Request-Id`; structured records omit query strings, bodies and error messages. The API defaults to loopback binding; set `API_HOST=0.0.0.0` only when a container network or reverse proxy requires it. `PORT` is validated as an integer from 1 through 65535.

Email is development-only and writes messages to ignored `.local/mail` files. A production email provider is not configured. See [operational readiness](docs/operations/operational-readiness.md) for the local backup/restore drill and deployment limitations.

Available root checks:

```sh
./scripts/pnpm.sh format:check
./scripts/pnpm.sh typecheck
./scripts/pnpm.sh test:unit
./scripts/pnpm.sh test:integration
./scripts/pnpm.sh build
./scripts/pnpm.sh ci:check
```

Integration tests require the isolated PostgreSQL test databases and required test secrets/configuration. `ci:check` does not imply that database integration tests ran; run `test:integration` separately. See [testing strategy](docs/testing/strategy.md) and [the Phase 1 roadmap](docs/roadmap/PHASE_1_EXTENDED_IMPLEMENTATION_ROADMAP.md).

## Repository map

- `apps/web`: Next.js application shell
- `apps/api`: NestJS API, identity/business modules, Prisma schema, migrations and tests
- `apps/worker`: reserved workspace package; no worker behavior is implemented
- `packages/config`: shared TypeScript configurations
- `packages/contracts`, `packages/tooling`: workspace packages without substantive contracts/tooling yet
- `docs`: source-of-truth architecture, security, database, testing and operations notes

## Project status

The schema currently defines 25 Prisma models and five enums, including catalogue records. This is a partial foundation, not a commercial product or production deployment. Review the [Phase 2 roadmap](docs/roadmap/PHASE_2_IMPLEMENTATION_ROADMAP.md) for milestone status and deferred scope, and the [extended Phase 1 roadmap](docs/roadmap/PHASE_1_EXTENDED_IMPLEMENTATION_ROADMAP.md) for foundation evidence.

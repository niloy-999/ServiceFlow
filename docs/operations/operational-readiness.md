# Operational readiness

## Evidence and current status

Locally verified on Docker Desktop with PostgreSQL 17.12 Alpine (arm64): loopback-only published port, resource limits of 1 GiB and 1.5 CPU, separate bootstrap/migrator/runtime roles, and separate development, integration-test and Prisma shadow databases. All 18 migrations were applied to `serviceflow_dev` and `serviceflow_test`; 77 PostgreSQL integration tests passed against the isolated test database. Startup persistence is checked without deleting the named volume.

`/api/v1/health/live` is a process liveness response that does not query PostgreSQL. `/api/v1/health/ready` checks database connectivity; `/api/v1/health` remains its compatibility alias. These endpoints are implemented but no orchestrator probes are configured. The HTTP interceptor generates a UUID per request, returns `X-Request-Id`, and emits structured completion/error events. Logs use matched route templates or `unmatched`, and omit raw query/path values, bodies, IP addresses, user agents, caller correlation values and error messages. Exception categories are fixed safe labels. The existing JSON logger redacts configured sensitive fields. There is no metrics backend, aggregation, alerting or on-call integration.

The local recovery script creates a PostgreSQL custom-format archive outside the repository with mode 0600 and restores into a random new database. The successful drill verified 18 migrations, representative user/audit rows, no unvalidated foreign keys, migrator ownership, restricted runtime grants and two RLS-enabled tables; Prisma reported the restored database up to date. Its generated target was removed after verification. Two earlier generated targets were independently rechecked against the same conditions (including Prisma status and no-context tenant reads) and removed only after the previously observed idle session ended and ownership was confirmed. Development/test/shadow databases and the volume were not deleted.

These results are local development evidence only. No production deployment, production backup, independent penetration test, external monitoring, alerting, incident-response exercise, or production secret-management system is evidenced.

## Local PostgreSQL backup and restore drill

Prerequisites: local Compose PostgreSQL running through `scripts/local-postgres.sh`, committed migrations applied, root `.env.local` configured, workspace dependencies installed, and PostgreSQL 17 compatible `pg_dump`/`pg_restore` on the host. The script loads only root `.env.local`; it does not read `apps/api/.env`. It writes a private temporary libpq service file (mode 0600) so passwords do not appear in process arguments. The temporary directory is mode 0700. Archive path must be absolute, outside the repository, and nonexistent. The script refuses overwrite and never restores with `--clean`.

```sh
./scripts/pnpm.sh --filter @serviceflow/api exec node scripts/postgres-recovery-drill.mjs backup /private/tmp/serviceflow-local.dump
./scripts/pnpm.sh --filter @serviceflow/api exec node scripts/postgres-recovery-drill.mjs restore-drill /private/tmp/serviceflow-local.dump
```

The backup source is the database in `MIGRATION_DATABASE_URL`; to back up `serviceflow_test`, set that process variable to the isolated test URL without printing it. Restore creates a generated disposable database and validates migration records, representative table counts, foreign keys, ownership, runtime grants, RLS settings, audit immutability grant, runtime role attributes, and tenant reads without context. It checks Prisma migration status. It only drops its generated target after successful validation, with connections closed and database owner rechecked. A failed target is preserved for investigation. The archive remains outside Git and is the operator's responsibility to protect and remove securely.

The local drill is not a production backup procedure. For production, choose encrypted backups, retention, point-in-time recovery, RPO/RTO, access controls, independent failure domains, object-storage backup where applicable, and scheduled recorded restore drills. No production service or external account is configured here.

## Configuration, migrations and deployment

- Keep local environment files untracked. Use distinct runtime and migration credentials; never provide bootstrap credentials to the application.
- Production secrets belong in a managed secret store with access logging and rotation. Never reuse local values.
- Terminate TLS at a trusted reverse proxy/load balancer. Keep PostgreSQL on a private network with no public listener.
- Roll out schema changes with backward-compatible expand/contract steps. Review locks and long-running operations. Prefer forward corrective migrations; schema/data rollback is not automatic.
- Apply committed migrations with `serviceflow_migrator` in a controlled release step. Confirm target database identity and retain a tested recovery or forward-fix plan.
- Readiness and liveness routes are implemented. Configure orchestrator probes, TLS, startup/shutdown behavior and deployment health gates in the eventual hosting environment.

## Email delivery boundary

The local development adapter writes verification/reset mail to ignored `.local/mail` files, with directory mode 0700 and file mode 0600. It rejects local mode outside development and rejects unknown providers. No external provider, delivery guarantee, bounce handling, suppression list, sender domain, DKIM/SPF/DMARC or production credentials are implemented. Production release requires selecting and integrating a provider, configuring secrets safely, authenticating the sender domain, and testing delivery/retries/bounces/abuse controls.

## Monitoring and incident response

Before launch, establish database saturation/latency metrics, authentication-abuse and rate-limit signals, migration alerts, backup status and availability checks. Define severity, incident commander, evidence preservation, credential revocation/rotation, customer/regulatory communication review and post-incident actions. No alerting provider, log aggregation or on-call process is configured.

## Release gates

Require passing CI, isolated PostgreSQL migration/integration tests, reviewed migration and role grants, documented rollback/forward-fix plan, secret scan, deployment health checks, verified production backup/restore evidence, and release-appropriate security review. An independent penetration test remains a pre-public-launch requirement from the Phase 0 specification. No production release or independent assessment is claimed.

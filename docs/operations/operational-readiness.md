# Operational readiness expectations

## Current evidence

The API validates `WEB_APP_URL` as an HTTP(S) origin and requires HTTPS in production. CSRF, rate-limit and MFA key services validate their required secret formats when instantiated. `API_HOST` and `PORT` are validated; host defaults to loopback and the port must be in range. The API health endpoint queries PostgreSQL and reports database connectivity. The NestJS API logger emits JSON records and masks selected sensitive structured fields. Request correlation IDs, HTTP access logs, a metrics backend and log aggregation are not configured.

This repository does not evidence a production deployment, backup configuration, restore drill, monitoring/alerting integration, incident-response exercise, or production secret-management system.

## Configuration and deployment

- Keep local environment files untracked. Do not put credentials in Compose files, CI YAML, docs, command output, or Git history.
- Use distinct runtime and migration credentials. Runtime pods/processes receive only `serviceflow_app`; migration execution is a controlled release operation with `serviceflow_migrator`.
- Production secrets (session/CSRF, rate-limit HMAC, MFA encryption keyring, DB credentials) belong in a managed secret store with access logging and rotation. Never use local development values in production.
- Terminate TLS at a trusted reverse proxy/load balancer. Configure API host binding and allowed origin deliberately; keep PostgreSQL on a private network with no public listener.
- Roll out schema changes using backward-compatible expand/contract steps. Review locks and long-running operations before deployment. Prefer forward corrective migrations; rollback of schema/data is not automatic.
- Apply committed migrations with `serviceflow_migrator` during a controlled release step. Confirm the target database identity first and retain a forward-fix or tested-restore plan; do not treat migration rollback as automatic data recovery.
- Readiness should include required dependency availability; liveness should not cause restart loops on transient database failure. Current implementation has only a DB-backed health endpoint.

## Backup and restore procedure requirements

Before production data exists, select a PostgreSQL provider and define encrypted backups, retention, point-in-time recovery, RPO/RTO, access controls and independent failure domains. Back up any object storage separately when it is introduced. Document a restore into an isolated target, validate migration compatibility and record data-integrity checks. Schedule and record restore drills. A written procedure is not evidence that a backup or drill exists.

For a future managed PostgreSQL environment, an operator should provision a new isolated restore database first, with the expected application/migration roles and `serviceflow_migrator` as database owner. Keep archive files outside the repository, use encrypted storage, and never enable shell tracing while handling connection configuration. A logical backup can use:

```sh
umask 077
pg_dump --format=custom --file="$BACKUP_FILE" "$BACKUP_DATABASE_URL"
```

Restore only into a newly created empty target. Do not use `--clean` or restore over an existing database:

```sh
pg_restore --exit-on-error --no-owner --dbname="$RESTORE_DATABASE_URL" "$BACKUP_FILE"
```

After restore, check migration status, validate representative record counts and foreign-key/business invariants, verify runtime grants and RLS under `serviceflow_app`, and exercise health and critical workflows before directing traffic. Record the restore timestamp, backup identifier, target, checks and exceptions. These commands are a runbook starting point; no backup or restore has been executed for this repository.

## Monitoring and incident response

Before launch, establish structured request/error logs with secret and personal-data redaction, request correlation IDs, database saturation/latency metrics, auth-abuse and rate-limit signals, migration alerts, backup status and availability checks. Define severity, incident commander, evidence preservation, credential revocation/rotation, customer/regulatory communication review, and post-incident actions. No alerting provider or on-call process is configured in this repository.

## Release gates

Require passing CI, isolated PostgreSQL migration/integration tests, reviewed migration/role grants, documented rollback or forward-fix plan, secret scan, deployment health checks, verified backup/restore evidence, and security review appropriate to the release. An independent penetration test remains a pre-public-launch requirement from the Phase 0 specification.

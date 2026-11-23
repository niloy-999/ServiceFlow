# ADR 0001: Modular monolith for the application backend

- **Status:** Accepted baseline
- **Date:** 2026-11-23

## Context

ServiceFlow is an early multi-tenant SaaS foundation. Its current workflows share identity, authorization context, PostgreSQL transactions and audit requirements. The repository already uses one NestJS API and one PostgreSQL database. There is not yet measured scale, independent team ownership, or an operational platform that would justify distributed services.

## Decision

Keep backend capabilities in one NestJS modular monolith. Modules own HTTP/application behavior and use explicit Nest provider dependencies. PostgreSQL is the authoritative data store. Tenant context and security-sensitive changes remain in bounded database transactions. The web application communicates with the API and does not own business rules or import Prisma models.

## Consequences

- Local development and deployment have fewer moving parts.
- Cross-module operations can share transaction scope and audit insertion.
- Module boundaries must remain explicit to avoid a monolith becoming a dependency tangle.
- A worker or separate service can be introduced when an actual asynchronous workload or scaling boundary exists, with an ADR and data/transaction contract.
- This decision does not claim that all intended product modules or operational deployment are implemented.

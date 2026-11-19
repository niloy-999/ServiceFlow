# ServiceFlow

ServiceFlow is a multi-tenant SaaS platform for computer retail shops and repair/service centres.

It brings retail operations, inventory, point of sale, repair management, customer support and customer-facing services into one platform.

## Project status

Early development — Phase 1: Foundation.

Product requirements and architecture decisions are being implemented incrementally. Features are not considered complete until tested and documented.

## Technology baseline

- Frontend: Next.js
- Backend: NestJS modular monolith
- Database: PostgreSQL
- ORM: Prisma
- Monorepo: pnpm workspaces
- Runtime: Node.js 24.10.0
- Package manager: pnpm 10.34.9

## Development prerequisites

- Node.js 24.10.0
- Corepack
- Git

## Runtime verification

From the repository root:

    corepack pnpm run check:runtime

## Engineering principles

- Tenant isolation and backend-enforced authorization.
- Explicit module boundaries.
- Database constraints for data integrity.
- Automated tests for critical business workflows.
- Reproducible dependencies and builds.
- Security, privacy and auditability by design.

## Repository structure

- apps/: application projects
- packages/: shared packages
- docs/: architecture and engineering documentation
- infrastructure/: infrastructure configuration
- scripts/: development and verification scripts

## License

All rights reserved. No license has been granted for reuse or redistribution.

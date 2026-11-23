# ServiceFlow 0.2 — Catalogue and Inventory Implementation Roadmap

**Authority:** Phase 2 requirements trace to `docs/architecture/SERVICEFLOW_PHASE_0_SPECIFICATION.md` §2.2, §3.1–3.3, §3.5, §6.2–6.3, §6.5–6.6, §9, §10 and §14. The approved 0.2 implementation decisions in the project handoff refine open implementation details. This roadmap records delivery evidence; it does not change the frozen specification.

**Status vocabulary:** `Verified` means the listed implementation and check have actually completed. `In progress` means implementation has started but acceptance is incomplete. `Execution-unverified` means source exists but the required run has not occurred. `Deferred` is intentionally outside 0.2. This project has not been independently penetration tested or production deployed.

## Release boundary

Release 0.2 delivers tenant onboarding/authorization, product catalogue, branch inventory, suppliers, purchasing and receiving, supplier returns, and controlled branch transfers. Stock identity is a product variant. Quantities are integer base units. The immutable movement ledger is authoritative and branch balances are transactional projections. Physical, reserved, available and in-transit quantities remain distinct; order-linked reservations are deferred.

POS, sales, customer orders, payments, invoices/refunds, repairs/parts consumption, barcode hardware, image storage, full stock counts, accounting and advanced warehouse management are deferred to later releases. The only reservation foundation in 0.2 is a balance quantity and the availability invariant; no order reservation workflow or foreign key is introduced.

## Milestones

### M0 — Tenant workspace and authorization

**Status:** Verified locally. **Dependencies:** Phase 1 identity, tenant RLS, MFA and audit foundations.

**Implemented:** Additive authorization migration creates stable permission identifiers and branch scopes with tenant-consistent keys/RLS. Backend `AuthorizationService` checks active tenant membership, code-owned permission, branch membership/status and separate view/operation scope in one transaction. Platform activation requires an active platform administrator and MFA-verified session; it locks the pending business, requires exactly one eligible initial applicant with enabled MFA, then creates the initial branch, system roles, owner assignment/scope, activation state and audit event atomically. MFA is enforced for active business owners/administrators, including session validation/rotation and MFA disable.

**Verified:** `20261124090000_business_authorization_foundation` and `20261124100000_platform_activation_mfa_check` applied to local `serviceflow_dev` and isolated `serviceflow_test`. The full PostgreSQL integration suite passed **79/79** after the owner MFA/RLS correction. Coverage includes pending registration, MFA-authenticated platform activation, rejected non-admin activation, initial branch/owner/system-role/business-scope creation, activation audit, duplicate activation rejection, membership discovery, cross-tenant denial and separate branch visibility/operation scope. `AuthorizationService` executes protected callbacks in the same tenant transaction as permission and scope evaluation.

**Remaining:** Run root unit/type/build checks and CI against the committed milestone. Fresh CI migrations will be verified by the workflow. Role and membership-management APIs are not part of this initial activation foundation; no employee grant/removal API exists yet. The activation migration was applied locally and is additive; this is not independent security testing or production verification.

### M1 — Catalogue

**Status:** Not implemented. **Dependencies:** M0 authorization and tenant-aware schema conventions.

**Objective:** Categories, brands, products, default and explicit variants, identifiers, product kinds (`RETAIL`, `REPAIR_PART`, `BOTH`), serial-tracking configuration and price history; authorized API and usable web workflows.

**Acceptance:** Tenant composite keys prevent foreign tenant relationships; variant is canonical stock identity; product creation always produces at least one variant; `BOTH` uses one identity; identifiers are normalized and tenant-unique; price history uses integer minor units; create/update/archive are authorized and audited; DTO validation and UI loading/empty/error/denied states are covered.

**Verification:** Migration deploy on a fresh PostgreSQL database; API/contract and PostgreSQL tests for tenant uniqueness, variants, identifiers, product kinds, prices, archive constraints and audit; frontend build and Playwright create/list/detail/edit/archive workflows; RLS plus runtime-role grants check.

### M2 — Inventory engine

**Status:** Not implemented. **Dependencies:** M1 variant identity.

**Objective:** Branch balances, immutable ledger, transactional movements, serial units, adjustments, negative-stock authorization and explicit quantity semantics.

**Acceptance:** Every physical delta and projection update are one transaction; append-only ledger is not updatable/deletable by runtime; available equals physical less reserved; in-transit is separate; integer quantities; serial unit has one consistent variant/branch/lifecycle; adjustment requires reason and audit; manager override cannot create physical quantity; idempotency prevents replay; row locking/conditional updates preserve balances under concurrency.

**Verification:** PostgreSQL integration tests for ledger/projection atomicity, rollback, RLS, constraints, runtime grants, same-variant competing mutations, duplicate idempotency keys, serialized unit constraints and adjustment approvals. No SQLite substitute.

### M3 — Suppliers, purchasing and receiving

**Status:** Not implemented. **Dependencies:** M0, M1 and M2.

**Objective:** Suppliers, purchase orders, direct receipts, partial receipts, accepted/damaged/rejected quantities, cancellation, posting idempotency and supplier returns.

**Acceptance:** PO lifecycle never mutates physical stock; accepted receipt only creates inbound physical movements; damaged/rejected quantities do not; cumulative accepted cannot exceed ordered less cancelled; partial receipts preserve outstanding quantities; retries do not duplicate; cancellation closes only outstanding quantities; accepted history persists; dispatched supplier returns reduce stock once and cannot exceed accepted less prior returns; transitions require authorization and same-transaction audit.

**Verification:** API/state-machine tests and PostgreSQL constraint, concurrent receive, duplicate-post, return-cap and cancellation-history tests; RLS and cross-tenant reference tests; E2E order/receive/partial/cancel/return flows.

### M4 — Branch transfers

**Status:** Not implemented. **Dependencies:** M2 movement primitives and M0 scope enforcement.

**Objective:** Request/approval and separately authorized direct transfers; dispatch, in-transit quantities, destination receipt, discrepancy resolution and safe cancellation.

**Acceptance:** Same-tenant active source and destination plus both actor scopes are checked; self-transfer rejected; approval/direct paths use common dispatch and receipt; dispatch atomically lowers source physical and raises in-transit; receipt lowers transit and raises destination by accepted quantity; no in-transit stock is available; discrepancies are explicitly recorded and resolved with compensating ledger/audit; dispatch and receipt replay are idempotent.

**Verification:** Concurrent source dispatch tests, duplicate command replay, partial receipt/discrepancy workflows, cross-tenant/branch authorization and RLS tests; full transfer E2E.

### M5 — Full 0.2 release acceptance

**Status:** Not started. **Dependencies:** M0–M4.

**Acceptance:** OpenAPI matches implemented endpoints; usable responsive and accessible screens exist; unit, PostgreSQL integration, authorization, tenant/RLS, API contract, concurrency/idempotency, migration and Playwright E2E tests pass; clean database migrations pass; CI installs frozen lockfile, formats, types, unit tests, builds, applies PostgreSQL migrations, runs integration tests and secret scan; README and architecture/security/testing/operational documentation match implementation; final commit is synchronized to `main`, CI passes, and tree is clean.

**Production-only gates:** Production provider configuration, deployment, backups/restore objectives, monitoring/alerting, incident exercises, legal/privacy review and independent professional security assessment require separate evidence and remain outside the claim of local 0.2 verification.

## Database change log

- `20261124090000_business_authorization_foundation`: code-owned permission seed, `BranchScopeType`, tenant-composite branch/membership scopes, uniqueness and RLS.
- `20261124100000_platform_activation_mfa_check`: least-disclosure security-definer boolean for activation eligibility, callable only by an active platform administrator in global identity context.

Later milestone migrations will be recorded here only after implementation and verification.

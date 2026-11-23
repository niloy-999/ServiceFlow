-- Stable capability identifiers are owned by application code and seeded here.
INSERT INTO permissions (code, description, risk_class) VALUES
    ('catalogue.read', 'View the product catalogue', 'LOW'),
    ('catalogue.manage', 'Create and maintain catalogue records', 'MEDIUM'),
    ('inventory.read', 'View inventory balances and movements', 'LOW'),
    ('inventory.adjust', 'Initiate inventory adjustments', 'HIGH'),
    ('inventory.adjust.approve', 'Approve inventory adjustments', 'HIGH'),
    ('inventory.override_negative', 'Authorize an adjustment that results in negative stock', 'CRITICAL'),
    ('inventory.receive', 'Receive accepted supplier goods', 'HIGH'),
    ('supplier.read', 'View suppliers', 'LOW'),
    ('supplier.manage', 'Create and maintain suppliers', 'MEDIUM'),
    ('purchasing.read', 'View purchase orders and receipts', 'LOW'),
    ('purchasing.manage', 'Create and manage purchase orders', 'MEDIUM'),
    ('purchasing.approve', 'Approve purchase orders', 'HIGH'),
    ('purchasing.return.dispatch', 'Dispatch supplier returns', 'HIGH'),
    ('inventory.transfer.request', 'Request branch transfers', 'MEDIUM'),
    ('inventory.transfer.approve', 'Approve branch transfers', 'HIGH'),
    ('inventory.transfer.direct', 'Create direct authorized branch transfers', 'HIGH'),
    ('inventory.transfer.dispatch', 'Dispatch branch transfers', 'HIGH'),
    ('inventory.transfer.receive', 'Receive branch transfers', 'HIGH'),
    ('inventory.transfer.discrepancy.resolve', 'Resolve transfer discrepancies', 'HIGH'),
    ('platform.tenant.activate', 'Activate a pending tenant and initial owner membership', 'CRITICAL')
ON CONFLICT (code) DO NOTHING;

CREATE TYPE "BranchScopeType" AS ENUM ('BUSINESS', 'BRANCH');

CREATE TABLE "membership_branch_scopes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "scope_type" "BranchScopeType" NOT NULL,
    "branch_id" UUID,
    "can_view" BOOLEAN NOT NULL DEFAULT true,
    "can_operate" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "membership_branch_scopes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "membership_branch_scopes_scope_check" CHECK (
        ("scope_type" = 'BUSINESS' AND "branch_id" IS NULL)
        OR ("scope_type" = 'BRANCH' AND "branch_id" IS NOT NULL)
    ),
    CONSTRAINT "membership_branch_scopes_membership_fkey"
        FOREIGN KEY ("tenant_id", "membership_id")
        REFERENCES "tenant_memberships"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "membership_branch_scopes_branch_fkey"
        FOREIGN KEY ("tenant_id", "branch_id")
        REFERENCES "branches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "membership_branch_scopes_business_unique"
    ON "membership_branch_scopes"("tenant_id", "membership_id")
    WHERE "scope_type" = 'BUSINESS';
CREATE UNIQUE INDEX "membership_branch_scopes_branch_unique"
    ON "membership_branch_scopes"("tenant_id", "membership_id", "branch_id")
    WHERE "scope_type" = 'BRANCH';
CREATE INDEX "membership_branch_scopes_membership_idx"
    ON "membership_branch_scopes"("tenant_id", "membership_id");

ALTER TABLE "membership_branch_scopes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "membership_branch_scopes"
    FOR ALL TO serviceflow_app
    USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "membership_branch_scopes" TO serviceflow_app;

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_type" VARCHAR(16) NOT NULL,
    "actor_user_id" UUID,
    "tenant_id" UUID,
    "action" VARCHAR(120) NOT NULL,
    "target_type" VARCHAR(80) NOT NULL,
    "target_id" VARCHAR(160),
    "outcome" VARCHAR(16) NOT NULL,
    "request_id" VARCHAR(128),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events"("occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_occurred_at_idx" ON "audit_events"("actor_user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_occurred_at_idx" ON "audit_events"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_target_type_target_id_idx" ON "audit_events"("target_type", "target_id");

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Validate audit event identity and outcome.
ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_actor_type_check"
    CHECK (
        ("actor_type" = 'USER' AND "actor_user_id" IS NOT NULL)
        OR
        ("actor_type" = 'SYSTEM' AND "actor_user_id" IS NULL)
    );

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_outcome_check"
    CHECK ("outcome" IN ('SUCCESS', 'FAILURE'));

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_action_not_blank_check"
    CHECK (length(btrim("action")) > 0);

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_target_type_not_blank_check"
    CHECK (length(btrim("target_type")) > 0);

-- Runtime receives INSERT only.
REVOKE ALL PRIVILEGES ON TABLE "audit_events"
    FROM serviceflow_app;

GRANT INSERT ON TABLE "audit_events"
    TO serviceflow_app;

-- Audit records are global or scoped to the current tenant.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "audit_events_scoped_insert"
    ON "audit_events"
    FOR INSERT
    TO serviceflow_app
    WITH CHECK (
        "actor_type" = 'USER'
        AND "actor_user_id" =
            NULLIF(current_setting('app.user_id', true), '')::uuid
        AND (
            (
                "tenant_id" IS NULL
                AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL
            )
            OR
            (
                "tenant_id" =
                    NULLIF(current_setting('app.tenant_id', true), '')::uuid
            )
        )
    );

-- Reject row-level modifications to historical audit records.
CREATE FUNCTION public.reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are immutable.';
END;
$$;

CREATE TRIGGER "audit_events_immutable"
    BEFORE UPDATE OR DELETE ON "audit_events"
    FOR EACH ROW
    EXECUTE FUNCTION public.reject_audit_event_mutation();

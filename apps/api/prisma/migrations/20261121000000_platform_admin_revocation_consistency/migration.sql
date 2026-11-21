ALTER TABLE "platform_administrators"
    ADD CONSTRAINT "platform_administrators_revocation_status_check"
    CHECK (
        ("status" <> 'ACTIVE' OR "revoked_at" IS NULL)
        AND
        ("revoked_at" IS NULL OR "status" = 'SUSPENDED')
    );

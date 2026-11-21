-- Runtime enrollment may create only a PENDING MFA configuration.
-- The status and enabled_at columns must retain their database defaults.

REVOKE INSERT ON TABLE "user_mfa" FROM serviceflow_app;

GRANT INSERT ("id", "user_id", "encrypted_secret", "updated_at")
    ON TABLE "user_mfa"
    TO serviceflow_app;

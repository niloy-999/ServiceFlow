-- Restrict runtime writes to the TOTP replay counter and its timestamp.
REVOKE UPDATE ON TABLE "user_mfa" FROM serviceflow_app;

GRANT UPDATE ("last_accepted_time_step", "updated_at")
    ON TABLE "user_mfa"
    TO serviceflow_app;

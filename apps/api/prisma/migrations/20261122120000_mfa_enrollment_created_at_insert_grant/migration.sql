-- Prisma enrollment creation requires INSERT privilege on created_at.
-- Keep this grant column-scoped; do not grant table-level INSERT.

GRANT INSERT ("created_at")
ON TABLE "mfa_enrollments"
TO serviceflow_app;

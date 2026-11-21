-- Preserve every failed MFA verification attempt as a separate audit event.
DROP INDEX "audit_events_mfa_failure_once_per_challenge_idx";

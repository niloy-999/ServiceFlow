-- Record at most one failed MFA verification event per challenge.
CREATE UNIQUE INDEX "audit_events_mfa_failure_once_per_challenge_idx"
ON "audit_events" ("actor_user_id", "target_id")
WHERE
    "action" = 'auth.mfa.challenge_verification_failed'
    AND "target_type" = 'MFA_CHALLENGE'
    AND "outcome" = 'FAILURE';

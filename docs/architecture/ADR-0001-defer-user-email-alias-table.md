# ADR-0001: Defer the User Email Alias Table

- **Status:** Accepted
- **Date:** 2026-11-20

## Context

The frozen ServiceFlow Phase 0 specification includes a `user_emails`
table to support multiple email addresses per user.

The initial identity schema already stores `email_normalized` on `users`.
Adding a separate `user_emails` table with its own unique constraint would
not guarantee global uniqueness across both tables.

Application-level existence checks would not solve this reliably because
concurrent requests could pass the checks before either transaction inserts
the same normalized email address.

## Decision

For the initial identity and authentication foundation:

- Keep `users.email_normalized` as the authoritative email address.
- Defer the `user_emails` table and multiple-email functionality.
- Do not modify the frozen Phase 0 specification.
- Revisit multiple email addresses only after designing a database-enforced
  global uniqueness strategy.

Possible future approaches include a unified canonical email registry or
a single authoritative table with a unique normalized email value.

## Consequences

- Initial authentication supports one authoritative email address per user.
- Multiple email addresses, aliases, and their verification lifecycle are
  deferred.
- Future implementation must prevent duplicate normalized addresses across
  all users at the database level, including under concurrent writes.
- This is an implementation sequencing decision, not a change to the
  approved Phase 0 product requirements.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { CsrfService } from "../dist/identity/csrf.service.js";

process.env.CSRF_HMAC_SECRET ??= randomBytes(32).toString("hex");

const csrf = new CsrfService();

test("Generated CSRF tokens validate against their originating session", () => {
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = csrf.generateToken(sessionToken);

  assert.match(csrfToken, /^[a-f0-9]{64}$/);
  assert.equal(csrf.verifyToken(sessionToken, csrfToken), true);
});

test("CSRF tokens cannot be reused with another session", () => {
  const firstSession = randomBytes(32).toString("base64url");
  const secondSession = randomBytes(32).toString("base64url");
  const csrfToken = csrf.generateToken(firstSession);

  assert.equal(csrf.verifyToken(secondSession, csrfToken), false);
});

test("Modified CSRF tokens are rejected", () => {
  const sessionToken = randomBytes(32).toString("base64url");
  const csrfToken = csrf.generateToken(sessionToken);
  const replacement = csrfToken[0] === "a" ? "b" : "a";
  const modifiedToken = replacement + csrfToken.slice(1);

  assert.equal(csrf.verifyToken(sessionToken, modifiedToken), false);
});

test("Malformed CSRF tokens are rejected without throwing", () => {
  const sessionToken = randomBytes(32).toString("base64url");

  for (const token of ["", "invalid", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
    assert.equal(csrf.verifyToken(sessionToken, token), false);
  }
});

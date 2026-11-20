import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import {
  clearSessionCookie,
  createSessionCookie,
  readSessionCookie,
  SESSION_COOKIE_NAME,
} from "../dist/identity/session-cookie.js";

test("Reads a valid session cookie", () => {
  const token = randomBytes(32).toString("base64url");

  assert.equal(readSessionCookie(`${SESSION_COOKIE_NAME}=${token}`), token);
});

test("Rejects missing, malformed, and duplicate session cookies", () => {
  const token = randomBytes(32).toString("base64url");

  assert.equal(readSessionCookie(undefined), null);
  assert.equal(readSessionCookie(""), null);
  assert.equal(readSessionCookie(`${SESSION_COOKIE_NAME}=invalid`), null);
  assert.equal(
    readSessionCookie(`${SESSION_COOKIE_NAME}=${token}; ${SESSION_COOKIE_NAME}=${token}`),
    null,
  );
});

test("Ignores unrelated cookies while reading the session cookie", () => {
  const token = randomBytes(32).toString("base64url");

  assert.equal(
    readSessionCookie(`theme=dark; another=value; ${SESSION_COOKIE_NAME}=${token}`),
    token,
  );
});

test("Creates a secure host-only HttpOnly session cookie", () => {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const cookie = createSessionCookie(token, expiresAt);

  assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=${token};`));
  assert.match(cookie, /;\s*Path=\//);
  assert.match(cookie, /;\s*HttpOnly/);
  assert.match(cookie, /;\s*Secure/);
  assert.match(cookie, /;\s*SameSite=Lax/);
  assert.doesNotMatch(cookie, /;\s*Domain=/i);
  assert.match(cookie, /;\s*Max-Age=\d+/);
});

test("Clears the session cookie using matching security attributes", () => {
  const cookie = clearSessionCookie();

  assert.ok(cookie.startsWith(`${SESSION_COOKIE_NAME}=;`));
  assert.match(cookie, /;\s*Path=\//);
  assert.match(cookie, /;\s*HttpOnly/);
  assert.match(cookie, /;\s*Secure/);
  assert.match(cookie, /;\s*SameSite=Lax/);
  assert.match(cookie, /;\s*Max-Age=0/);
});

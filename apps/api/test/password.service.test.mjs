import assert from "node:assert/strict";
import test from "node:test";

import { PasswordService } from "../dist/identity/password.service.js";

const passwordService = new PasswordService();

test("PasswordService hashes and verifies passwords", async () => {
  const password = "ServiceFlow-Test-Password-123!";
  const encodedHash = await passwordService.hashPassword(password);

  assert.match(encodedHash, /^\$argon2id\$v=19\$/);
  assert.notEqual(encodedHash, password);

  assert.equal(await passwordService.verifyPassword(password, encodedHash), true);
  assert.equal(await passwordService.verifyPassword("incorrect-password", encodedHash), false);

  assert.equal(passwordService.needsRehash(encodedHash), false);
});

test("PasswordService safely handles malformed hashes", async () => {
  assert.equal(await passwordService.verifyPassword("any-password", "not-a-valid-hash"), false);

  assert.equal(passwordService.needsRehash("not-a-valid-hash"), true);
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { MfaCryptoService } = await import("../dist/identity/mfa-crypto.service.js");

const mfa = new MfaCryptoService();

test("AES-256-GCM encrypts and decrypts an MFA secret", () => {
  const secret = randomBytes(20);
  const encrypted = mfa.encryptSecret(secret);

  assert.ok(Buffer.isBuffer(encrypted));
  assert.equal(encrypted.length, 20 + 12 + 16);
  assert.deepEqual(mfa.decryptSecret(encrypted), secret);
  assert.notDeepEqual(encrypted, secret);
});

test("Encryption uses a fresh nonce for every operation", () => {
  const secret = randomBytes(20);

  const first = mfa.encryptSecret(secret);
  const second = mfa.encryptSecret(secret);

  assert.notDeepEqual(first, second);
  assert.deepEqual(mfa.decryptSecret(first), secret);
  assert.deepEqual(mfa.decryptSecret(second), secret);
});

test("AES-GCM rejects modified ciphertext and authentication tags", () => {
  const encrypted = mfa.encryptSecret(randomBytes(20));

  for (const index of [0, 12, encrypted.length - 1]) {
    const modified = Buffer.from(encrypted);
    modified[index] ^= 0x01;

    assert.throws(() => mfa.decryptSecret(modified), /Unable to decrypt MFA secret/);
  }
});

test("Malformed encrypted secrets are rejected", () => {
  for (const value of [Buffer.alloc(0), Buffer.alloc(28)]) {
    assert.throws(() => mfa.decryptSecret(value));
  }
});

test("TOTP generation matches RFC 6238 SHA-1 test vectors", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");

  const vectors = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  for (const [timestamp, expected] of vectors) {
    const step = Math.floor(timestamp / 30);

    assert.equal(mfa.generateTotpCode(secret, step, 8), expected);
  }
});

test("TOTP generation produces six-digit codes by default", () => {
  const code = mfa.generateTotpCode(Buffer.from("12345678901234567890"), 1);

  assert.match(code, /^\d{6}$/);
});

test("TOTP verification accepts the previous, current, and next time step", () => {
  const secret = randomBytes(20);
  const currentStep = 1000;
  const nowMs = currentStep * 30_000;

  for (const step of [currentStep - 1, currentStep, currentStep + 1]) {
    const code = mfa.generateTotpCode(secret, step);

    assert.equal(mfa.verifyTotpCode(secret, code, nowMs), step);
  }
});

test("TOTP verification rejects codes outside the permitted time window", () => {
  const secret = randomBytes(20);
  const currentStep = 1000;
  const nowMs = currentStep * 30_000;

  for (const step of [currentStep - 2, currentStep + 2]) {
    const code = mfa.generateTotpCode(secret, step);

    assert.equal(mfa.verifyTotpCode(secret, code, nowMs), null);
  }
});

test("TOTP verification rejects malformed codes and invalid timestamps", () => {
  const secret = randomBytes(20);

  for (const code of ["", "12345", "1234567", "abcdef", "12345a"]) {
    assert.equal(mfa.verifyTotpCode(secret, code, 30_000), null);
  }

  assert.equal(mfa.verifyTotpCode(secret, "123456", -1), null);
  assert.equal(mfa.verifyTotpCode(secret, "123456", Infinity), null);
});

test("TOTP generation rejects invalid time steps and digit counts", () => {
  const secret = randomBytes(20);

  assert.throws(() => mfa.generateTotpCode(secret, -1));
  assert.throws(() => mfa.generateTotpCode(secret, 1.5));
  assert.throws(() => mfa.generateTotpCode(secret, 1, 7));
});

test("Recovery codes contain 128 bits of randomness and are hashed", () => {
  const code = mfa.generateRecoveryCode();

  assert.match(code, /^[A-F0-9]{8}(-[A-F0-9]{8}){3}$/);

  const hash = mfa.hashRecoveryCode(code);

  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, mfa.hashRecoveryCode(code.replace(/-/g, "").toLowerCase()));
  assert.notEqual(hash, code);
});

test("Recovery-code hashing rejects malformed input", () => {
  for (const code of ["", "1234", "Z".repeat(32), "A".repeat(31)]) {
    assert.throws(() => mfa.hashRecoveryCode(code));
  }
});

test("MFA encryption key must be a valid base64-encoded 32-byte key", () => {
  const original = process.env.MFA_ENCRYPTION_KEY;

  try {
    for (const invalidKey of ["", "not-base64", randomBytes(16).toString("base64")]) {
      process.env.MFA_ENCRYPTION_KEY = invalidKey;

      assert.throws(() => new MfaCryptoService(), /MFA_ENCRYPTION_KEY/);
    }
  } finally {
    process.env.MFA_ENCRYPTION_KEY = original;
  }
});

test("TOTP secrets contain 160 bits of cryptographic randomness", () => {
  const first = mfa.generateTotpSecret();
  const second = mfa.generateTotpSecret();

  assert.equal(first.length, 20);
  assert.equal(second.length, 20);
  assert.notDeepEqual(first, second);
});

test("Base32 encoding and decoding round-trip binary secrets", () => {
  const samples = [
    Buffer.from("f"),
    Buffer.from("fo"),
    Buffer.from("foo"),
    Buffer.from("foob"),
    Buffer.from("fooba"),
    Buffer.from("foobar"),
    randomBytes(20),
  ];

  for (const sample of samples) {
    const encoded = mfa.encodeBase32(sample);
    assert.match(encoded, /^[A-Z2-7]+$/);
    assert.deepEqual(mfa.decodeBase32(encoded), sample);
  }
});

test("Base32 encoding matches RFC 4648 test vectors", () => {
  const vectors = [
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];

  for (const [plain, encoded] of vectors) {
    assert.equal(mfa.encodeBase32(Buffer.from(plain)), encoded);
    assert.deepEqual(mfa.decodeBase32(encoded), Buffer.from(plain));
  }
});

test("Base32 decoding rejects malformed and non-canonical values", () => {
  for (const value of ["", "0", "1", "ABC=", "ABC!", "A", "AB"]) {
    assert.throws(() => mfa.decodeBase32(value));
  }
});

test("TOTP provisioning URI contains standard authenticator parameters", () => {
  const secret = Buffer.from("12345678901234567890", "ascii");
  const uri = mfa.createTotpProvisioningUri(secret, "user@example.com", "ServiceFlow");

  assert.ok(uri.startsWith("otpauth://totp/"));
  assert.ok(uri.includes("secret=" + mfa.encodeBase32(secret)));
  assert.ok(uri.includes("issuer=ServiceFlow"));
  assert.ok(uri.includes("algorithm=SHA1"));
  assert.ok(uri.includes("digits=6"));
  assert.ok(uri.includes("period=30"));
  assert.ok(uri.includes("ServiceFlow%3Auser%40example.com"));
});

test("TOTP provisioning URI rejects missing account or issuer", () => {
  const secret = randomBytes(20);

  assert.throws(() => mfa.createTotpProvisioningUri(secret, "", "ServiceFlow"));
  assert.throws(() => mfa.createTotpProvisioningUri(secret, "user@example.com", ""));
  assert.throws(() =>
    mfa.createTotpProvisioningUri(Buffer.alloc(0), "user@example.com", "ServiceFlow"),
  );
});

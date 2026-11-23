import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { test } from "node:test";

delete process.env.MFA_ENCRYPTION_KEYS;
delete process.env.MFA_ENCRYPTION_ACTIVE_KEY_ID;
delete process.env.MFA_ENCRYPTION_LEGACY_KEY_ID;
process.env.MFA_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const { MfaCryptoService } = await import("../dist/identity/mfa-crypto.service.js");

const mfa = new MfaCryptoService();

function createConfiguredService(keys, activeKeyId, legacyKeyId) {
  const names = [
    "MFA_ENCRYPTION_KEY",
    "MFA_ENCRYPTION_KEYS",
    "MFA_ENCRYPTION_ACTIVE_KEY_ID",
    "MFA_ENCRYPTION_LEGACY_KEY_ID",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );

  try {
    delete process.env.MFA_ENCRYPTION_KEY;
    process.env.MFA_ENCRYPTION_KEYS = JSON.stringify(
      Object.fromEntries(
        Object.entries(keys).map(([id, key]) => [
          id,
          key.toString("base64"),
        ]),
      ),
    );
    process.env.MFA_ENCRYPTION_ACTIVE_KEY_ID = activeKeyId;
    process.env.MFA_ENCRYPTION_LEGACY_KEY_ID = legacyKeyId;

    return new MfaCryptoService();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
}

function assertInvalidKeyringConfiguration(
  { keyring, legacyKey, activeKeyId = "v2", legacyKeyId = "v1" },
  expectedError,
) {
  const names = [
    "MFA_ENCRYPTION_KEY",
    "MFA_ENCRYPTION_KEYS",
    "MFA_ENCRYPTION_ACTIVE_KEY_ID",
    "MFA_ENCRYPTION_LEGACY_KEY_ID",
  ];
  const previous = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );

  try {
    for (const name of names) {
      delete process.env[name];
    }

    if (keyring !== undefined) {
      process.env.MFA_ENCRYPTION_KEYS = keyring;
    }
    if (legacyKey !== undefined) {
      process.env.MFA_ENCRYPTION_KEY = legacyKey;
    }

    process.env.MFA_ENCRYPTION_ACTIVE_KEY_ID = activeKeyId;
    process.env.MFA_ENCRYPTION_LEGACY_KEY_ID = legacyKeyId;

    assert.throws(() => new MfaCryptoService(), expectedError);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
}

function encryptLegacySecret(secret, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(secret),
    cipher.final(),
  ]);

  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

test("AES-256-GCM encrypts and decrypts an MFA secret", () => {
  const secret = randomBytes(20);
  const encrypted = mfa.encryptSecret(secret);

  assert.ok(Buffer.isBuffer(encrypted));
  assert.equal(mfa.getEncryptedSecretKeyId(encrypted), "v1");
  assert.equal(mfa.isEncryptedSecretCurrent(encrypted), true);
  assert.ok(encrypted.length > 20 + 12 + 16);
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

  const headerLength = 8 + 2 + 2;
  const nonceOffset = headerLength;
  const authTagOffset = nonceOffset + 12;

  for (const index of [
    0,
    8,
    nonceOffset,
    authTagOffset,
    encrypted.length - 1,
  ]) {
    const modified = Buffer.from(encrypted);
    modified[index] ^= 0x01;

    assert.throws(() => mfa.decryptSecret(modified));
  }
});

test("Malformed encrypted secrets are rejected", () => {
  for (const value of [Buffer.alloc(0), Buffer.alloc(28)]) {
    assert.throws(() => mfa.decryptSecret(value));
  }
});

test("Legacy nonce-tag-ciphertext secrets remain decryptable", () => {
  const key = Buffer.from(process.env.MFA_ENCRYPTION_KEY, "base64");
  const secret = randomBytes(20);
  const legacy = encryptLegacySecret(secret, key);

  assert.equal(mfa.getEncryptedSecretKeyId(legacy), null);
  assert.equal(mfa.isEncryptedSecretCurrent(legacy), false);
  assert.deepEqual(mfa.decryptSecret(legacy), secret);
});

test("Multiple configured keys decrypt legacy and versioned secrets", () => {
  const keyV1 = randomBytes(32);
  const keyV2 = randomBytes(32);
  const secret = randomBytes(20);

  const v1Service = createConfiguredService(
    { v1: keyV1, v2: keyV2 },
    "v1",
    "v1",
  );
  const legacy = encryptLegacySecret(secret, keyV1);
  const versionedV1 = v1Service.encryptSecret(secret);

  const v2Service = createConfiguredService(
    { v1: keyV1, v2: keyV2 },
    "v2",
    "v1",
  );
  const versionedV2 = v2Service.encryptSecret(secret);

  assert.deepEqual(v2Service.decryptSecret(legacy), secret);
  assert.deepEqual(v2Service.decryptSecret(versionedV1), secret);
  assert.deepEqual(v2Service.decryptSecret(versionedV2), secret);

  assert.equal(v2Service.getEncryptedSecretKeyId(versionedV1), "v1");
  assert.equal(v2Service.getEncryptedSecretKeyId(versionedV2), "v2");
  assert.equal(v2Service.isEncryptedSecretCurrent(versionedV1), false);
  assert.equal(v2Service.isEncryptedSecretCurrent(versionedV2), true);
});

test("Unknown envelope key IDs are rejected", () => {
  const keyV1 = randomBytes(32);
  const keyV2 = randomBytes(32);

  const v1Service = createConfiguredService(
    { v1: keyV1 },
    "v1",
    "v1",
  );
  const encrypted = v1Service.encryptSecret(randomBytes(20));

  // The key ID begins immediately after the 8-byte magic and 2-byte header.
  encrypted[10] = "z".charCodeAt(0);

  const v2OnlyService = createConfiguredService(
    { v2: keyV2 },
    "v2",
    "v2",
  );

  assert.equal(v2OnlyService.getEncryptedSecretKeyId(encrypted), "z1");
  assert.throws(
    () => v2OnlyService.decryptSecret(encrypted),
    /Unable to decrypt MFA secret/,
  );
});

test("Versioned envelope key IDs are authenticated", () => {
  const keyV1 = randomBytes(32);
  const keyV2 = randomBytes(32);
  const secret = randomBytes(20);

  const service = createConfiguredService(
    { v1: keyV1, v2: keyV2 },
    "v1",
    "v1",
  );

  const encrypted = service.encryptSecret(secret);

  // Preserve the envelope structure but change its key ID from v1 to v2.
  encrypted[10] = "v".charCodeAt(0);
  encrypted[11] = "2".charCodeAt(0);

  const multiKeyService = createConfiguredService(
    { v1: keyV1, v2: keyV2 },
    "v2",
    "v1",
  );

  assert.equal(multiKeyService.getEncryptedSecretKeyId(encrypted), "v2");
  assert.throws(
    () => multiKeyService.decryptSecret(encrypted),
    /Unable to decrypt MFA secret/,
  );
});

test("Malformed versioned envelope headers are rejected", () => {
  const encrypted = mfa.encryptSecret(randomBytes(20));

  const invalidVersion = Buffer.from(encrypted);
  invalidVersion[8] = 0xff;

  const invalidKeyIdLength = Buffer.from(encrypted);
  invalidKeyIdLength[9] = 0xff;

  assert.throws(
    () => mfa.getEncryptedSecretKeyId(invalidVersion),
    /Invalid MFA encryption envelope/,
  );
  assert.throws(
    () => mfa.getEncryptedSecretKeyId(invalidKeyIdLength),
    /Invalid MFA encryption envelope/,
  );
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
    for (const invalidKey of [
      "",
      "not-base64",
      randomBytes(16).toString("base64"),
    ]) {
      process.env.MFA_ENCRYPTION_KEY = invalidKey;

      assert.throws(() => new MfaCryptoService(), /MFA/);
    }
  } finally {
    process.env.MFA_ENCRYPTION_KEY = original;
  }
});

test("MFA keyring rejects ambiguous and malformed configuration", () => {
  const validKey = randomBytes(32).toString("base64");

  assertInvalidKeyringConfiguration(
    {
      keyring: JSON.stringify({ v1: validKey, v2: validKey }),
      legacyKey: validKey,
    },
    /must not be configured alongside/,
  );

  assertInvalidKeyringConfiguration(
    { keyring: "{", },
    /valid JSON keyring/,
  );

  assertInvalidKeyringConfiguration(
    { keyring: "[]", },
    /JSON object/,
  );

  assertInvalidKeyringConfiguration(
    {
      keyring: JSON.stringify({ v1: validKey.slice(0, -1), v2: validKey }),
    },
    /canonical base64/,
  );

  assertInvalidKeyringConfiguration(
    {
      keyring: JSON.stringify({ "bad.id": validKey, v2: validKey }),
    },
    /invalid entry/,
  );
});

test("MFA keyring rejects missing active and legacy keys", () => {
  const key = randomBytes(32);

  assert.throws(
    () => createConfiguredService({ v1: key }, "v2", "v1"),
    /active MFA encryption key is missing/,
  );

  assert.throws(
    () => createConfiguredService({ v2: key }, "v2", "v1"),
    /legacy MFA encryption key is missing/,
  );
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

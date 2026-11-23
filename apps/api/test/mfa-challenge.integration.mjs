import "dotenv/config";

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "pg";

import { AppModule } from "../dist/app.module.js";
import { PasswordService } from "../dist/identity/password.service.js";
import { PrismaService } from "../dist/database/prisma.service.js";
import { MfaCryptoService } from "../dist/identity/mfa-crypto.service.js";
import { RateLimitService } from "../dist/rate-limit/rate-limit.service.js";

const userId = randomUUID();
const email = `${userId}@example.invalid`;
const password = "integration-mfa-password";
const frontendOrigin = new URL(process.env.WEB_APP_URL).origin;

let app;
let migrator;
let appClient;
let apiBaseUrl;
let passwords;
let mfaCrypto;
let secret;
let recoveryCode;
let fixturesCreated = false;

let blockedRateLimit = null;
const rateLimitCalls = [];

const rateLimitProvider = {
  async consume(input) {
    rateLimitCalls.push(input);

    const blocked =
      blockedRateLimit !== null &&
      input.operation === blockedRateLimit.operation &&
      input.dimension === blockedRateLimit.dimension;

    return {
      allowed: !blocked,
      retryAfterSeconds: 42,
    };
  },
};

const cookieName = "__Host-serviceflow_session";

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function cookieHeader(token) {
  return `${cookieName}=${token}`;
}

function getCookie(response) {
  const value = response.headers.get("set-cookie");
  assert.ok(value, "Expected a session cookie");
  const match = value.match(new RegExp(`${cookieName}=([^;]+)`));
  assert.ok(match, "Expected the ServiceFlow session cookie");
  return match[1];
}

async function login() {
  return fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: frontendOrigin,
    },
    body: JSON.stringify({ email, password }),
  });
}

async function verify(challengeToken, code) {
  return fetch(`${apiBaseUrl}/api/v1/auth/mfa/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: frontendOrigin,
    },
    body: JSON.stringify({ challengeToken, code }),
  });
}

async function createChallenge() {
  const response = await login();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mfaRequired, true);
  assert.match(body.challengeToken, /^[A-Za-z0-9_-]{43}$/);
  return body.challengeToken;
}

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.MIGRATION_DATABASE_URL);
  assert.ok(process.env.WEB_APP_URL);
  assert.ok(process.env.CSRF_HMAC_SECRET);
  assert.ok(process.env.MFA_ENCRYPTION_KEYS || process.env.MFA_ENCRYPTION_KEY);

  migrator = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await migrator.connect();

  const identity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(identity.rows[0].role, "serviceflow_migrator");
  assert.equal(identity.rows[0].database, "serviceflow_test");

  appClient = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await appClient.connect();

  const runtimeIdentity = await appClient.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(runtimeIdentity.rows[0].role, "serviceflow_app");
  assert.equal(runtimeIdentity.rows[0].database, "serviceflow_test");

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(RateLimitService)
    .useValue(rateLimitProvider)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }),
  );

  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine integration server address.");
  }
  apiBaseUrl = `http://127.0.0.1:${address.port}`;

  passwords = app.get(PasswordService);
  mfaCrypto = app.get(MfaCryptoService);

  const prisma = app.get(PrismaService);
  const appIdentity = await prisma.$queryRaw`
    SELECT current_user AS role, current_database() AS database
  `;
  assert.equal(appIdentity[0].role, "serviceflow_app");
  assert.equal(appIdentity[0].database, "serviceflow_test");

  const mfaPrivileges = await migrator.query(`
    SELECT
      has_table_privilege(
        'serviceflow_app', 'public.user_mfa', 'UPDATE'
      ) AS table_update,
      has_table_privilege(
        'serviceflow_app', 'public.user_mfa', 'SELECT'
      ) AS table_select,
      has_table_privilege(
        'serviceflow_app', 'public.user_mfa', 'INSERT'
      ) AS table_insert,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa', 'id', 'INSERT'
      ) AS id_insert,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa', 'user_id', 'INSERT'
      ) AS user_id_insert,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa', 'encrypted_secret', 'INSERT'
      ) AS secret_insert,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa', 'updated_at', 'INSERT'
      ) AS timestamp_insert,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa', 'status', 'INSERT'
      ) AS status_insert,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa', 'enabled_at', 'INSERT'
      ) AS enabled_at_insert,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa',
        'last_accepted_time_step', 'INSERT'
      ) AS replay_counter_insert,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa',
        'last_accepted_time_step', 'UPDATE'
      ) AS replay_update,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa',
        'updated_at', 'UPDATE'
      ) AS timestamp_update,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa',
        'encrypted_secret', 'UPDATE'
      ) AS secret_update,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa',
        'status', 'UPDATE'
      ) AS status_update,
      has_column_privilege(
        'serviceflow_app', 'public.user_mfa',
        'enabled_at', 'UPDATE'
      ) AS enabled_at_update
  `);

  assert.equal(mfaPrivileges.rowCount, 1);
  assert.equal(mfaPrivileges.rows[0].table_update, false);
  assert.equal(mfaPrivileges.rows[0].table_select, true);
  assert.equal(mfaPrivileges.rows[0].table_insert, false);
  assert.equal(mfaPrivileges.rows[0].id_insert, true);
  assert.equal(mfaPrivileges.rows[0].user_id_insert, true);
  assert.equal(mfaPrivileges.rows[0].secret_insert, true);
  assert.equal(mfaPrivileges.rows[0].timestamp_insert, true);
  assert.equal(mfaPrivileges.rows[0].status_insert, false);
  assert.equal(mfaPrivileges.rows[0].enabled_at_insert, false);
  assert.equal(mfaPrivileges.rows[0].replay_counter_insert, false);
  assert.equal(mfaPrivileges.rows[0].replay_update, true);
  assert.equal(mfaPrivileges.rows[0].timestamp_update, true);
  assert.equal(mfaPrivileges.rows[0].secret_update, false);
  assert.equal(mfaPrivileges.rows[0].status_update, false);
  assert.equal(mfaPrivileges.rows[0].enabled_at_update, false);

  const passwordHash = await passwords.hashPassword(password);
  await migrator.query(
    `INSERT INTO users (
       id, email_normalized, password_hash, email_verified_at, status, updated_at
     )
     VALUES ($1, $2, $3, NOW(), 'ACTIVE', NOW())`,
    [userId, email, passwordHash],
  );
  fixturesCreated = true;

  secret = mfaCrypto.generateTotpSecret();
  await migrator.query(
    `INSERT INTO user_mfa (
       id, user_id, encrypted_secret, status, enabled_at, updated_at
     )
     VALUES ($1, $2, $3, 'ENABLED', NOW(), NOW())`,
    [randomUUID(), userId, mfaCrypto.encryptSecret(secret)],
  );
});

after(async () => {
  try {
    if (migrator && fixturesCreated) {
      await migrator.query("BEGIN");
      try {
        // Test teardown only: temporarily disable audit immutability.
        await migrator.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable");

        await migrator.query("DELETE FROM audit_events WHERE actor_user_id = $1", [userId]);

        await migrator.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable");

        await migrator.query("DELETE FROM mfa_challenges WHERE user_id = $1", [userId]);
        await migrator.query("DELETE FROM mfa_enrollments WHERE user_id = $1", [userId]);
        await migrator.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [userId]);
        await migrator.query("DELETE FROM user_mfa WHERE user_id = $1", [userId]);
        await migrator.query("DELETE FROM auth_sessions WHERE user_id = $1", [userId]);
        await migrator.query("DELETE FROM users WHERE id = $1", [userId]);

        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    if (app) await app.close();
    if (appClient) await appClient.end();
    if (migrator) await migrator.end();
  }
});

test("Runtime database role cannot insert an enabled MFA configuration", async () => {
  const candidateUserId = randomUUID();

  await appClient.query("BEGIN");
  try {
    await appClient.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', '', true)",
      [candidateUserId],
    );

    await assert.rejects(
      appClient.query(
        `INSERT INTO user_mfa (
           id, user_id, encrypted_secret, updated_at, status, enabled_at
         ) VALUES ($1, $2, $3, NOW(), 'ENABLED', NOW())`,
        [randomUUID(), candidateUserId, Buffer.alloc(32)],
      ),
      (error) => error.code === "42501",
    );
  } finally {
    await appClient.query("ROLLBACK");
  }
});

test("Runtime database role cannot insert an MFA replay counter", async () => {
  const candidateUserId = randomUUID();

  await appClient.query("BEGIN");
  try {
    await appClient.query(
      "SELECT set_config('app.user_id', $1, true), set_config('app.tenant_id', '', true)",
      [candidateUserId],
    );

    await assert.rejects(
      appClient.query(
        `INSERT INTO user_mfa (
           id, user_id, encrypted_secret, updated_at, last_accepted_time_step
         ) VALUES ($1, $2, $3, NOW(), 123456)`,
        [randomUUID(), candidateUserId, Buffer.alloc(32)],
      ),
      (error) => error.code === "42501",
    );
  } finally {
    await appClient.query("ROLLBACK");
  }
});

test("MFA-enabled password login returns a challenge without creating a session", async () => {
  const response = await login();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);

  const body = await response.json();
  assert.equal(body.mfaRequired, true);
  assert.match(body.challengeToken, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(body.expiresAt);
  assert.equal(Object.hasOwn(body, "csrfToken"), false);

  const tokenHash = hashToken(body.challengeToken);
  const stored = await migrator.query(
    `SELECT token_hash, consumed_at, expires_at
     FROM mfa_challenges WHERE user_id = $1`,
    [userId],
  );

  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].token_hash, tokenHash);
  assert.notEqual(stored.rows[0].token_hash, body.challengeToken);
  assert.equal(stored.rows[0].consumed_at, null);
  assert.ok(new Date(stored.rows[0].expires_at) > new Date());

  const sessions = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );
  assert.equal(sessions.rows[0].total, 0);
});

test("MFA verification enforces IP and challenge rate limits before factor verification", async () => {
  const scenarios = [
    { dimension: "ip", expectedCalls: 1 },
    { dimension: "challenge", expectedCalls: 2 },
  ];

  try {
    for (const scenario of scenarios) {
      const challengeToken = await createChallenge();
      const challengeHash = hashToken(challengeToken);
      const code = mfaCrypto.generateTotpCode(secret, Math.floor(Date.now() / 30000));

      rateLimitCalls.length = 0;
      blockedRateLimit = {
        operation: "mfa-verify",
        dimension: scenario.dimension,
      };

      const response = await verify(challengeToken, code);

      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "42");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(rateLimitCalls.length, scenario.expectedCalls);

      const ipCall = rateLimitCalls[0];
      assert.equal(ipCall.operation, "mfa-verify");
      assert.equal(ipCall.dimension, "ip");
      assert.equal(ipCall.limit, 20);
      assert.equal(ipCall.windowSeconds, 900);
      assert.equal(ipCall.identifier, "127.0.0.1");

      if (scenario.dimension === "challenge") {
        const challengeCall = rateLimitCalls[1];
        assert.equal(challengeCall.operation, "mfa-verify");
        assert.equal(challengeCall.dimension, "challenge");
        assert.equal(challengeCall.identifier, challengeHash);
        assert.notEqual(challengeCall.identifier, challengeToken);
        assert.equal(challengeCall.limit, 5);
        assert.equal(challengeCall.windowSeconds, 900);
      }

      const storedChallenge = await migrator.query(
        `SELECT consumed_at FROM mfa_challenges
         WHERE token_hash = $1`,
        [challengeHash],
      );
      assert.equal(storedChallenge.rowCount, 1);
      assert.equal(storedChallenge.rows[0].consumed_at, null);

      const sessions = await migrator.query(
        "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
        [userId],
      );
      assert.equal(sessions.rows[0].total, 0);
    }
  } finally {
    blockedRateLimit = null;
    rateLimitCalls.length = 0;
  }
});

test("An expired MFA challenge is rejected without creating a session", async () => {
  const challengeToken = await createChallenge();
  const tokenHash = hashToken(challengeToken);
  const expired = await migrator.query(
    `UPDATE mfa_challenges
     SET
       created_at = NOW() - INTERVAL '10 minutes',
       expires_at = NOW() - INTERVAL '1 second'
     WHERE token_hash = $1`,
    [tokenHash],
  );
  assert.equal(expired.rowCount, 1);

  const sessionsBefore = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  const code = mfaCrypto.generateTotpCode(secret, Math.floor(Date.now() / 30000));
  const response = await verify(challengeToken, code);

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);

  const challenge = await migrator.query(
    "SELECT consumed_at FROM mfa_challenges WHERE token_hash = $1",
    [tokenHash],
  );
  assert.equal(challenge.rowCount, 1);
  assert.equal(challenge.rows[0].consumed_at, null);

  const sessionsAfter = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );
  assert.equal(sessionsAfter.rows[0].total, sessionsBefore.rows[0].total);
});

test("An unknown MFA challenge is rejected without creating a session", async () => {
  const unknownToken = "A".repeat(43);
  const code = mfaCrypto.generateTotpCode(secret, Math.floor(Date.now() / 30000));

  const sessionsBefore = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  const response = await verify(unknownToken, code);

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);

  const sessionsAfter = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );
  assert.equal(sessionsAfter.rows[0].total, sessionsBefore.rows[0].total);
});

test("A suspended user cannot complete MFA verification", async () => {
  const challengeToken = await createChallenge();
  const tokenHash = hashToken(challengeToken);
  const code = mfaCrypto.generateTotpCode(secret, Math.floor(Date.now() / 30000));

  const sessionsBefore = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  await migrator.query("UPDATE users SET status = 'SUSPENDED', updated_at = NOW() WHERE id = $1", [
    userId,
  ]);

  let response;
  try {
    response = await verify(challengeToken, code);
  } finally {
    await migrator.query("UPDATE users SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1", [
      userId,
    ]);
  }

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);

  const challenge = await migrator.query(
    "SELECT consumed_at FROM mfa_challenges WHERE token_hash = $1",
    [tokenHash],
  );
  assert.equal(challenge.rowCount, 1);
  assert.equal(challenge.rows[0].consumed_at, null);

  const sessionsAfter = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );
  assert.equal(sessionsAfter.rows[0].total, sessionsBefore.rows[0].total);
});

test("A valid TOTP consumes the challenge and creates an MFA-verified session", async () => {
  const challengeToken = await createChallenge();
  const code = mfaCrypto.generateTotpCode(secret, Math.floor(Date.now() / 30000));

  const response = await verify(challengeToken, code);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const body = await response.json();
  assert.match(body.csrfToken, /^[a-f0-9]{64}$/);
  assert.ok(body.expiresAt);

  const sessionToken = getCookie(response);
  assert.match(sessionToken, /^[A-Za-z0-9_-]{43}$/);

  const session = await migrator.query(
    `SELECT mfa_verified_at
     FROM auth_sessions
     WHERE user_id = $1 AND session_hash = $2`,
    [userId, hashToken(sessionToken)],
  );
  assert.equal(session.rowCount, 1);
  assert.ok(session.rows[0].mfa_verified_at);

  const challenge = await migrator.query(
    `SELECT consumed_at FROM mfa_challenges
     WHERE token_hash = $1`,
    [hashToken(challengeToken)],
  );
  assert.ok(challenge.rows[0].consumed_at);

  const audit = await migrator.query(
    `SELECT count(*)::int AS total
     FROM audit_events
     WHERE actor_user_id = $1
       AND action = 'auth.mfa.challenge_verified'
       AND outcome = 'SUCCESS'`,
    [userId],
  );
  assert.equal(audit.rows[0].total, 1);

  const replay = await verify(challengeToken, code);
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.get("set-cookie"), null);
});

test("A recovery code can be consumed only once", async () => {
  recoveryCode = mfaCrypto.generateRecoveryCode();

  await migrator.query(
    `INSERT INTO mfa_recovery_codes (id, user_id, code_hash)
     VALUES ($1, $2, $3)`,
    [randomUUID(), userId, mfaCrypto.hashRecoveryCode(recoveryCode)],
  );

  const firstChallenge = await createChallenge();
  const firstResponse = await verify(firstChallenge, recoveryCode);

  assert.equal(firstResponse.status, 200);
  assert.ok(getCookie(firstResponse));

  const stored = await migrator.query(
    `SELECT consumed_at FROM mfa_recovery_codes
     WHERE user_id = $1 AND code_hash = $2`,
    [userId, mfaCrypto.hashRecoveryCode(recoveryCode)],
  );
  assert.ok(stored.rows[0].consumed_at);

  const secondChallenge = await createChallenge();
  const reuseResponse = await verify(secondChallenge, recoveryCode);

  assert.equal(reuseResponse.status, 401);
  assert.equal(reuseResponse.headers.get("set-cookie"), null);
});

test("Each failed MFA factor is audited without consuming the challenge", async () => {
  await migrator.query("UPDATE user_mfa SET last_accepted_time_step = NULL WHERE user_id = $1", [
    userId,
  ]);

  const challengeToken = await createChallenge();
  const tokenHash = hashToken(challengeToken);
  const currentStep = Math.floor(Date.now() / 30000);

  const acceptedCodes = [-1, 0, 1].map((offset) =>
    mfaCrypto.generateTotpCode(secret, currentStep + offset),
  );
  const invalidCode = ["000000", "000001", "000002"].find(
    (candidate) => !acceptedCodes.includes(candidate),
  );

  assert.ok(invalidCode, "Expected a code outside the accepted TOTP window.");

  const sessionsBefore = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await verify(challengeToken, invalidCode);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  }

  const challengeAfterFailures = await migrator.query(
    "SELECT id, consumed_at FROM mfa_challenges WHERE token_hash = $1",
    [tokenHash],
  );
  assert.equal(challengeAfterFailures.rowCount, 1);
  assert.equal(challengeAfterFailures.rows[0].consumed_at, null);

  const failureAudit = await migrator.query(
    `SELECT count(*)::int AS total
     FROM audit_events
     WHERE actor_user_id = $1
       AND target_id = $2
       AND action = 'auth.mfa.challenge_verification_failed'
       AND target_type = 'MFA_CHALLENGE'
       AND outcome = 'FAILURE'`,
    [
      userId,
      (await migrator.query("SELECT id FROM mfa_challenges WHERE token_hash = $1", [tokenHash]))
        .rows[0].id,
    ],
  );
  assert.equal(failureAudit.rows[0].total, 2);

  const sessionsAfterFailures = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );
  assert.equal(sessionsAfterFailures.rows[0].total, sessionsBefore.rows[0].total);

  const validCode = mfaCrypto.generateTotpCode(secret, Math.floor(Date.now() / 30000));
  const successfulResponse = await verify(challengeToken, validCode);

  assert.equal(successfulResponse.status, 200);
  assert.ok(getCookie(successfulResponse));

  const challengeAfterSuccess = await migrator.query(
    "SELECT consumed_at FROM mfa_challenges WHERE token_hash = $1",
    [tokenHash],
  );
  assert.ok(challengeAfterSuccess.rows[0].consumed_at);

  const successAudit = await migrator.query(
    `SELECT count(*)::int AS total
     FROM audit_events
     WHERE actor_user_id = $1
       AND target_id = $2
       AND action = 'auth.mfa.challenge_verified'
       AND outcome = 'SUCCESS'`,
    [userId, challengeAfterFailures.rows[0].id],
  );
  assert.equal(successAudit.rows[0].total, 1);
});

test("Concurrent verification of the same challenge creates exactly one session", async () => {
  await migrator.query("UPDATE user_mfa SET last_accepted_time_step = NULL WHERE user_id = $1", [
    userId,
  ]);

  const challengeToken = await createChallenge();
  const currentStep = Math.floor(Date.now() / 30000);
  const code = mfaCrypto.generateTotpCode(secret, currentStep);

  const sessionsBefore = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  const responses = await Promise.all([verify(challengeToken, code), verify(challengeToken, code)]);

  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 401]);

  const successfulResponses = responses.filter((response) => response.status === 200);
  assert.equal(successfulResponses.length, 1);
  assert.ok(getCookie(successfulResponses[0]));

  const sessions = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );
  assert.equal(sessions.rows[0].total, sessionsBefore.rows[0].total + 1);

  const challenge = await migrator.query(
    "SELECT consumed_at FROM mfa_challenges WHERE token_hash = $1",
    [hashToken(challengeToken)],
  );
  assert.ok(challenge.rows[0].consumed_at);
});

test("Different challenges cannot reuse the same TOTP time step concurrently", async () => {
  await migrator.query("UPDATE user_mfa SET last_accepted_time_step = NULL WHERE user_id = $1", [
    userId,
  ]);

  const [firstChallenge, secondChallenge] = await Promise.all([
    createChallenge(),
    createChallenge(),
  ]);

  const currentStep = Math.floor(Date.now() / 30000);
  const code = mfaCrypto.generateTotpCode(secret, currentStep);

  const sessionsBefore = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  const responses = await Promise.all([
    verify(firstChallenge, code),
    verify(secondChallenge, code),
  ]);

  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 401]);

  const successfulResponses = responses.filter((response) => response.status === 200);
  assert.equal(successfulResponses.length, 1);
  assert.ok(getCookie(successfulResponses[0]));

  const sessions = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );
  assert.equal(sessions.rows[0].total, sessionsBefore.rows[0].total + 1);

  const challenges = await migrator.query(
    `SELECT count(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS consumed
     FROM mfa_challenges
     WHERE token_hash = ANY($1::char(64)[])`,
    [[hashToken(firstChallenge), hashToken(secondChallenge)]],
  );
  assert.equal(challenges.rows[0].consumed, 1);
});

test("MFA enrollment activation enforces ownership, expiry and one-time consumption", async () => {
  const appUserCanExecute = await migrator.query(`
    SELECT has_function_privilege(
      'serviceflow_app',
      'public.activate_mfa_enrollment(uuid, uuid, bigint)',
      'EXECUTE'
    ) AS allowed
  `);
  assert.equal(appUserCanExecute.rows[0].allowed, true);

  const fixtures = [];

  try {
    const owner = await createActivationFixture();
    fixtures.push(owner);

    const otherUser = await createActivationFixture();
    fixtures.push(otherUser);

    const currentStep = Math.floor(Date.now() / 30000);

    // A different user's identity context must not activate this enrollment.
    await assert.rejects(
      activateEnrollment({
        contextUserId: otherUser.userId,
        userId: owner.userId,
        enrollmentId: owner.enrollmentId,
        timeStep: currentStep,
      }),
      (error) => error.code === "42501",
    );

    const stillPending = await migrator.query("SELECT id FROM mfa_enrollments WHERE id = $1", [
      owner.enrollmentId,
    ]);
    assert.equal(stillPending.rowCount, 1);

    // A valid owner context activates and consumes the enrollment.
    const enabledAt = await activateEnrollment({
      contextUserId: owner.userId,
      userId: owner.userId,
      enrollmentId: owner.enrollmentId,
      timeStep: currentStep,
    });

    assert.ok(enabledAt instanceof Date);

    const activeMfa = await migrator.query(
      `SELECT status, encrypted_secret, enabled_at,
              last_accepted_time_step
       FROM user_mfa
       WHERE user_id = $1`,
      [owner.userId],
    );

    assert.equal(activeMfa.rowCount, 1);
    assert.equal(activeMfa.rows[0].status, "ENABLED");
    assert.deepEqual(activeMfa.rows[0].encrypted_secret, owner.encryptedSecret);
    assert.equal(Number(activeMfa.rows[0].last_accepted_time_step), currentStep);
    assert.equal(activeMfa.rows[0].enabled_at.getTime(), enabledAt.getTime());

    const consumed = await migrator.query("SELECT id FROM mfa_enrollments WHERE id = $1", [
      owner.enrollmentId,
    ]);
    assert.equal(consumed.rowCount, 0);

    // The same enrollment cannot be activated a second time.
    await assert.rejects(
      activateEnrollment({
        contextUserId: owner.userId,
        userId: owner.userId,
        enrollmentId: owner.enrollmentId,
        timeStep: currentStep + 1,
      }),
      (error) => error.code === "P0002",
    );

    // An expired enrollment must not create an active MFA configuration.
    const expired = await createActivationFixture({ expired: true });
    fixtures.push(expired);

    await assert.rejects(
      activateEnrollment({
        contextUserId: expired.userId,
        userId: expired.userId,
        enrollmentId: expired.enrollmentId,
        timeStep: currentStep,
      }),
      (error) => error.code === "P0002",
    );

    const expiredMfa = await migrator.query("SELECT id FROM user_mfa WHERE user_id = $1", [
      expired.userId,
    ]);
    assert.equal(expiredMfa.rowCount, 0);

    const expiredEnrollment = await migrator.query("SELECT id FROM mfa_enrollments WHERE id = $1", [
      expired.enrollmentId,
    ]);
    assert.equal(expiredEnrollment.rowCount, 1);
  } finally {
    for (const fixture of fixtures) {
      await migrator.query("DELETE FROM mfa_enrollments WHERE user_id = $1", [fixture.userId]);
      await migrator.query("DELETE FROM user_mfa WHERE user_id = $1", [fixture.userId]);
      await migrator.query("DELETE FROM users WHERE id = $1", [fixture.userId]);
    }
  }
});

test("MFA enrollment start authenticates, replaces pending secrets safely, and enforces protections", async () => {
  // Establish one MFA-verified session. Reuse it throughout this test:
  // the fixture's TOTP replay protection intentionally prevents reuse.
  const challengeToken = await createChallenge();
  const code = mfaCrypto.generateTotpCode(secret, Math.floor(Date.now() / 30000) + 1);

  const verification = await verify(challengeToken, code);
  assert.equal(verification.status, 200);

  const verificationBody = await verification.json();
  const sessionToken = getCookie(verification);
  const csrfToken = verificationBody.csrfToken;

  assert.match(csrfToken, /^[a-f0-9]{64}$/);

  const enrollmentRequest = (body, csrf = csrfToken, origin = frontendOrigin) =>
    fetch(`${apiBaseUrl}/api/v1/auth/mfa/enrollment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        Cookie: cookieHeader(sessionToken),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: JSON.stringify(body),
    });

  const activeBefore = await migrator.query(
    `SELECT encrypted_secret, status, enabled_at
     FROM user_mfa
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(activeBefore.rowCount, 1);
  assert.equal(activeBefore.rows[0].status, "ENABLED");

  // 1. Successful enrollment start.
  const firstResponse = await enrollmentRequest({ password });
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get("cache-control"), "no-store");

  const firstBody = await firstResponse.json();
  assert.equal(typeof firstBody.provisioningUri, "string");
  assert.ok(firstBody.expiresAt);

  const firstUri = new URL(firstBody.provisioningUri);
  assert.equal(firstUri.protocol, "otpauth:");
  assert.equal(firstUri.searchParams.get("issuer"), "ServiceFlow");
  assert.ok(firstUri.searchParams.get("secret"));

  const firstLabel = decodeURIComponent(firstUri.pathname.slice(1));
  assert.equal(firstLabel, `ServiceFlow:${email}`);

  const firstEnrollment = await migrator.query(
    `SELECT id, encrypted_secret, expires_at
     FROM mfa_enrollments
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(firstEnrollment.rowCount, 1);
  assert.ok(firstEnrollment.rows[0].expires_at.getTime() > Date.now());
  assert.ok(firstEnrollment.rows[0].expires_at.getTime() <= Date.now() + 11 * 60 * 1000);

  const firstEnrollmentId = firstEnrollment.rows[0].id;
  const firstEncryptedSecret = firstEnrollment.rows[0].encrypted_secret.toString("hex");

  assert.notEqual(firstEncryptedSecret, activeBefore.rows[0].encrypted_secret.toString("hex"));

  // 2. Starting again replaces the pending secret, not active MFA.
  const secondResponse = await enrollmentRequest({ password });
  assert.equal(secondResponse.status, 200);
  assert.equal(secondResponse.headers.get("cache-control"), "no-store");

  const secondEnrollment = await migrator.query(
    `SELECT id, encrypted_secret, expires_at
     FROM mfa_enrollments
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(secondEnrollment.rowCount, 1);
  assert.equal(secondEnrollment.rows[0].id, firstEnrollmentId);
  assert.notEqual(secondEnrollment.rows[0].encrypted_secret.toString("hex"), firstEncryptedSecret);

  const activeAfterReplacement = await migrator.query(
    `SELECT encrypted_secret, status, enabled_at
     FROM user_mfa
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(activeAfterReplacement.rows[0].status, "ENABLED");
  assert.equal(
    activeAfterReplacement.rows[0].encrypted_secret.toString("hex"),
    activeBefore.rows[0].encrypted_secret.toString("hex"),
  );
  assert.equal(
    activeAfterReplacement.rows[0].enabled_at.getTime(),
    activeBefore.rows[0].enabled_at.getTime(),
  );

  // 3. Missing CSRF token must not start or replace an enrollment.
  const beforeCsrf = secondEnrollment.rows[0].encrypted_secret.toString("hex");
  const csrfResponse = await enrollmentRequest({ password }, null);

  assert.notEqual(csrfResponse.status, 200);

  const afterCsrf = await migrator.query(
    `SELECT encrypted_secret
     FROM mfa_enrollments
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(afterCsrf.rows[0].encrypted_secret.toString("hex"), beforeCsrf);

  // 4. Wrong password must fail and leave the pending enrollment unchanged.
  const wrongPasswordResponse = await enrollmentRequest({
    password: "definitely-the-wrong-password",
  });

  assert.equal(wrongPasswordResponse.status, 401);

  const afterWrongPassword = await migrator.query(
    `SELECT encrypted_secret
     FROM mfa_enrollments
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(afterWrongPassword.rows[0].encrypted_secret.toString("hex"), beforeCsrf);

  const failureAudit = await migrator.query(
    `SELECT count(*)::int AS total
     FROM audit_events
     WHERE actor_user_id = $1
       AND action = 'auth.mfa.enrollment_failed'
       AND outcome = 'FAILURE'`,
    [userId],
  );

  assert.equal(failureAudit.rows[0].total, 1);

  // 5. User-level rate limit must block before the service changes state.
  blockedRateLimit = {
    operation: "mfa-enrollment-start",
    dimension: "user",
  };

  try {
    const rateLimitedResponse = await enrollmentRequest({ password });
    assert.equal(rateLimitedResponse.status, 429);
    assert.equal(rateLimitedResponse.headers.get("retry-after"), "42");
  } finally {
    blockedRateLimit = null;
  }

  const afterRateLimit = await migrator.query(
    `SELECT encrypted_secret
     FROM mfa_enrollments
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(afterRateLimit.rows[0].encrypted_secret.toString("hex"), beforeCsrf);

  // Verify both successful starts were audited.
  const successAudit = await migrator.query(
    `SELECT count(*)::int AS total
     FROM audit_events
     WHERE actor_user_id = $1
       AND action = 'auth.mfa.enrollment_started'
       AND outcome = 'SUCCESS'`,
    [userId],
  );

  assert.equal(successAudit.rows[0].total, 2);
});

test("MFA authenticator replacement requires both factors and invalidates the old session", async () => {
  // Authenticate with the currently enabled authenticator.
  // Isolate this test from replay-counter state left by earlier tests.
  await migrator.query(
    `UPDATE user_mfa
     SET last_accepted_time_step = NULL
     WHERE user_id = $1`,
    [userId],
  );

  const challengeToken = await createChallenge();
  const loginStep = Math.floor(Date.now() / 30000) + 1;
  const loginCode = mfaCrypto.generateTotpCode(secret, loginStep);

  const verification = await verify(challengeToken, loginCode);
  assert.equal(verification.status, 200);

  const verificationBody = await verification.json();
  const sessionToken = getCookie(verification);
  const csrfToken = verificationBody.csrfToken;

  const headers = {
    "Content-Type": "application/json",
    Origin: frontendOrigin,
    Cookie: cookieHeader(sessionToken),
    "x-csrf-token": csrfToken,
  };

  // Start a replacement enrollment.
  const startResponse = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/enrollment`, {
    method: "POST",
    headers,
    body: JSON.stringify({ password }),
  });

  assert.equal(startResponse.status, 200);
  const startBody = await startResponse.json();

  const provisioningUri = new URL(startBody.provisioningUri);
  const encodedSecret = provisioningUri.searchParams.get("secret");
  assert.ok(encodedSecret);

  // Decode the Base32 secret from the provisioning URI.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const pendingBytes = [];
  let accumulator = 0;
  let bitCount = 0;

  for (const character of encodedSecret.toUpperCase()) {
    const value = alphabet.indexOf(character);
    assert.notEqual(value, -1, "Provisioning secret must be valid Base32.");

    accumulator = (accumulator << 5) | value;
    bitCount += 5;

    if (bitCount >= 8) {
      bitCount -= 8;
      pendingBytes.push((accumulator >> bitCount) & 0xff);
    }
  }

  const pendingSecret = Buffer.from(pendingBytes);

  // Capture the current authenticator before attempting replacement.
  const activeBefore = await migrator.query(
    `SELECT encrypted_secret, status, enabled_at, last_accepted_time_step
     FROM user_mfa
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(activeBefore.rowCount, 1);
  assert.equal(activeBefore.rows[0].status, "ENABLED");

  // Reset only this integration fixture's replay counter so the test
  // can use a fresh current-factor code without waiting for a time step.
  await migrator.query(
    `UPDATE user_mfa
     SET last_accepted_time_step = NULL
     WHERE user_id = $1`,
    [userId],
  );

  const timeStep = Math.floor(Date.now() / 30000) + 1;
  const currentCode = mfaCrypto.generateTotpCode(secret, timeStep);
  const pendingCode = mfaCrypto.generateTotpCode(pendingSecret, timeStep);

  const confirm = (body) =>
    fetch(`${apiBaseUrl}/api/v1/auth/mfa/enrollment/confirm`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

  // 1. Replacing an active authenticator requires the existing factor.
  const missingCurrentFactor = await confirm({
    password,
    pendingCode,
  });

  assert.equal(missingCurrentFactor.status, 401);

  // 2. A valid old factor cannot compensate for an invalid pending factor.
  let invalidPendingCode = "000000";
  while (mfaCrypto.verifyTotpCode(pendingSecret, invalidPendingCode, Date.now()) !== null) {
    invalidPendingCode = String((Number(invalidPendingCode) + 1) % 1000000).padStart(6, "0");
  }

  const invalidConfirmation = await confirm({
    password,
    currentCode,
    pendingCode: invalidPendingCode,
  });

  assert.equal(invalidConfirmation.status, 401);

  const afterInvalidConfirmation = await migrator.query(
    `SELECT encrypted_secret, status, enabled_at, last_accepted_time_step
     FROM user_mfa
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(afterInvalidConfirmation.rows[0].status, "ENABLED");
  assert.equal(
    afterInvalidConfirmation.rows[0].encrypted_secret.toString("hex"),
    activeBefore.rows[0].encrypted_secret.toString("hex"),
  );
  assert.equal(
    afterInvalidConfirmation.rows[0].enabled_at.getTime(),
    activeBefore.rows[0].enabled_at.getTime(),
  );
  assert.equal(afterInvalidConfirmation.rows[0].last_accepted_time_step, null);

  const pendingAfterFailure = await migrator.query(
    `SELECT id FROM mfa_enrollments WHERE user_id = $1`,
    [userId],
  );

  assert.equal(pendingAfterFailure.rowCount, 1);

  // 3. Both valid factors activate the replacement.
  const confirmation = await confirm({
    password,
    currentCode,
    pendingCode,
  });

  assert.equal(confirmation.status, 200);
  assert.equal(confirmation.headers.get("cache-control"), "no-store");

  const confirmationBody = await confirmation.json();
  assert.equal(confirmationBody.replaced, true);
  assert.ok(confirmationBody.enabledAt);

  // 4. The pending enrollment is consumed.
  const pendingAfterSuccess = await migrator.query(
    `SELECT id FROM mfa_enrollments WHERE user_id = $1`,
    [userId],
  );

  assert.equal(pendingAfterSuccess.rowCount, 0);

  // 5. The active secret is now the replacement secret.
  const activeAfterSuccess = await migrator.query(
    `SELECT encrypted_secret, status, enabled_at, last_accepted_time_step
     FROM user_mfa
     WHERE user_id = $1`,
    [userId],
  );

  assert.equal(activeAfterSuccess.rowCount, 1);
  assert.equal(activeAfterSuccess.rows[0].status, "ENABLED");
  assert.ok(
    mfaCrypto.decryptSecret(activeAfterSuccess.rows[0].encrypted_secret).equals(pendingSecret),
  );
  assert.ok(
    activeAfterSuccess.rows[0].enabled_at.getTime() >=
      new Date(confirmationBody.enabledAt).getTime() - 1,
  );
  assert.equal(activeAfterSuccess.rows[0].last_accepted_time_step.toString(), String(timeStep));

  // 6. Successful replacement must have an audit record.
  const replacementAudit = await migrator.query(
    `SELECT count(*)::int AS total
     FROM audit_events
     WHERE actor_user_id = $1
       AND action = 'auth.mfa.authenticator_replaced'
       AND outcome = 'SUCCESS'`,
    [userId],
  );

  assert.equal(replacementAudit.rows[0].total, 1);

  // 7. The previous MFA-verified session predates the new enabled_at.
  const oldSessionResponse = await fetch(`${apiBaseUrl}/api/v1/auth/me`, {
    method: "GET",
    headers: {
      Origin: frontendOrigin,
      Cookie: cookieHeader(sessionToken),
    },
  });

  assert.equal(oldSessionResponse.status, 401);
});

test("Recovery-code regeneration requires fresh authentication and atomically replaces the batch", async () => {
  // This test follows authenticator replacement. Reset only the test
  // fixture's replay counter so this test can establish a fresh session.
  await migrator.query(
    `UPDATE user_mfa
     SET last_accepted_time_step = NULL
     WHERE user_id = $1`,
    [userId],
  );

  const activeResult = await migrator.query(
    `SELECT encrypted_secret
     FROM user_mfa
     WHERE user_id = $1 AND status = 'ENABLED'`,
    [userId],
  );
  assert.equal(activeResult.rowCount, 1);

  const activeSecret = mfaCrypto.decryptSecret(Buffer.from(activeResult.rows[0].encrypted_secret));

  // Establish a fresh MFA-verified session.
  const loginStep = Math.floor(Date.now() / 30000);
  const challengeToken = await createChallenge();
  const verification = await verify(
    challengeToken,
    mfaCrypto.generateTotpCode(activeSecret, loginStep),
  );
  assert.equal(verification.status, 200);

  const verificationBody = await verification.json();
  const sessionToken = getCookie(verification);
  const csrfToken = verificationBody.csrfToken;
  assert.match(csrfToken, /^[a-f0-9]{64}$/);

  const regenerationStep = loginStep + 1;
  const currentCode = mfaCrypto.generateTotpCode(activeSecret, regenerationStep);

  const regenerationRequest = (body, csrf = csrfToken) =>
    fetch(`${apiBaseUrl}/api/v1/auth/mfa/recovery-codes/regenerate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: frontendOrigin,
        Cookie: cookieHeader(sessionToken),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: JSON.stringify(body),
    });

  // Insert a known old code to verify batch invalidation.
  const oldRecoveryCode = mfaCrypto.generateRecoveryCode();
  const oldRecoveryHash = mfaCrypto.hashRecoveryCode(oldRecoveryCode);

  await migrator.query(
    `INSERT INTO mfa_recovery_codes (id, user_id, code_hash)
     VALUES ($1, $2, $3)`,
    [randomUUID(), userId, oldRecoveryHash],
  );

  // Missing CSRF must not change the recovery-code batch.
  const csrfFailure = await regenerationRequest({ password, currentCode }, null);
  assert.equal(csrfFailure.status, 403);

  const oldCodeBefore = await migrator.query(
    `SELECT consumed_at
     FROM mfa_recovery_codes
     WHERE user_id = $1 AND code_hash = $2`,
    [userId, oldRecoveryHash],
  );
  assert.equal(oldCodeBefore.rowCount, 1);
  assert.equal(oldCodeBefore.rows[0].consumed_at, null);

  // Incorrect password must not consume the TOTP step or old codes.
  const passwordFailure = await regenerationRequest({
    password: "incorrect-password",
    currentCode,
  });
  assert.equal(passwordFailure.status, 401);

  // Find a definitely invalid six-digit code.
  let invalidCode = "000000";
  while (mfaCrypto.verifyTotpCode(activeSecret, invalidCode, Date.now()) !== null) {
    invalidCode = String((Number(invalidCode) + 1) % 1000000).padStart(6, "0");
  }

  const factorFailure = await regenerationRequest({
    password,
    currentCode: invalidCode,
  });
  assert.equal(factorFailure.status, 401);

  const oldCodeAfterFailures = await migrator.query(
    `SELECT consumed_at
     FROM mfa_recovery_codes
     WHERE user_id = $1 AND code_hash = $2`,
    [userId, oldRecoveryHash],
  );
  assert.equal(oldCodeAfterFailures.rows[0].consumed_at, null);

  // A valid password and fresh TOTP atomically replace the entire batch.
  const success = await regenerationRequest({
    password,
    currentCode,
  });
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("cache-control"), "no-store");

  const body = await success.json();
  assert.equal(body.recoveryCodes.length, 10);
  assert.ok(body.regeneratedAt);

  for (const code of body.recoveryCodes) {
    assert.match(code, /^[A-F0-9]{8}(-[A-F0-9]{8}){3}$/);
  }

  const oldCodeAfterSuccess = await migrator.query(
    `SELECT consumed_at
     FROM mfa_recovery_codes
     WHERE user_id = $1 AND code_hash = $2`,
    [userId, oldRecoveryHash],
  );
  assert.ok(oldCodeAfterSuccess.rows[0].consumed_at);

  const activeCodes = await migrator.query(
    `SELECT code_hash, consumed_at
     FROM mfa_recovery_codes
     WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );
  assert.equal(activeCodes.rowCount, 10);

  const expectedHashes = new Set(
    body.recoveryCodes.map((code) => mfaCrypto.hashRecoveryCode(code)),
  );
  const storedHashes = new Set(activeCodes.rows.map((row) => row.code_hash.trim()));
  assert.deepEqual(storedHashes, expectedHashes);
  assert.equal(activeCodes.rows.filter((row) => row.consumed_at === null).length, 10);

  // Reusing the same TOTP time step must fail.
  const replayFailure = await regenerationRequest({
    password,
    currentCode,
  });
  assert.equal(replayFailure.status, 401);

  // The previous batch's code must no longer authenticate.
  const oldCodeChallenge = await createChallenge();
  const oldCodeLogin = await verify(oldCodeChallenge, oldRecoveryCode);
  assert.equal(oldCodeLogin.status, 401);
  assert.equal(oldCodeLogin.headers.get("set-cookie"), null);

  // A newly issued recovery code works once, then cannot be reused.
  const newCode = body.recoveryCodes[0];
  const newCodeChallenge = await createChallenge();
  const newCodeLogin = await verify(newCodeChallenge, newCode);
  assert.equal(newCodeLogin.status, 200);
  assert.ok(getCookie(newCodeLogin));

  const reuseChallenge = await createChallenge();
  const reuseResponse = await verify(reuseChallenge, newCode);
  assert.equal(reuseResponse.status, 401);
  assert.equal(reuseResponse.headers.get("set-cookie"), null);

  const audit = await migrator.query(
    `SELECT action, outcome, count(*)::int AS total
     FROM audit_events
     WHERE actor_user_id = $1
       AND action IN (
         'auth.mfa.recovery_codes_regenerated',
         'auth.mfa.recovery_codes_regeneration_failed'
       )
     GROUP BY action, outcome`,
    [userId],
  );

  const successfulAudits = audit.rows.filter(
    (row) => row.action === "auth.mfa.recovery_codes_regenerated" && row.outcome === "SUCCESS",
  );
  assert.equal(successfulAudits.length, 1);
  assert.equal(successfulAudits[0].total, 1);

  const failedAudits = audit.rows.filter(
    (row) =>
      row.action === "auth.mfa.recovery_codes_regeneration_failed" && row.outcome === "FAILURE",
  );
  assert.ok(failedAudits.length >= 1);
  assert.ok(failedAudits.reduce((sum, row) => sum + row.total, 0) >= 3);
});

test("MFA disable requires fresh authentication and atomically revokes MFA credentials and sessions", async () => {
  // Isolate this final lifecycle test from replay-counter state left by
  // earlier tests, including authenticator replacement and recovery rotation.
  const activeResult = await migrator.query(
    `SELECT encrypted_secret
     FROM user_mfa
     WHERE user_id = $1 AND status = 'ENABLED'`,
    [userId],
  );
  assert.equal(activeResult.rowCount, 1);

  const activeSecret = mfaCrypto.decryptSecret(Buffer.from(activeResult.rows[0].encrypted_secret));

  await migrator.query(
    `UPDATE user_mfa
     SET last_accepted_time_step = NULL
     WHERE user_id = $1`,
    [userId],
  );

  // Use the previous TOTP step for login and the current step for disable.
  // This gives the test a fresh, strictly increasing factor without sleeping.
  const baseStep = Math.floor(Date.now() / 30000);
  const loginStep = baseStep - 1;
  const disableStep = baseStep;

  const loginResponse = await login();
  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.equal(loginBody.mfaRequired, true);

  const verification = await verify(
    loginBody.challengeToken,
    mfaCrypto.generateTotpCode(activeSecret, loginStep),
  );
  assert.equal(verification.status, 200);

  const verificationBody = await verification.json();
  const sessionToken = getCookie(verification);
  const csrfToken = verificationBody.csrfToken;
  assert.match(csrfToken, /^[a-f0-9]{64}$/);

  const currentCode = mfaCrypto.generateTotpCode(activeSecret, disableStep);

  const disableRequest = (body, csrf = csrfToken) =>
    fetch(`${apiBaseUrl}/api/v1/auth/mfa/disable`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: frontendOrigin,
        Cookie: cookieHeader(sessionToken),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      body: JSON.stringify(body),
    });

  // Seed all outstanding credentials that successful disable must invalidate.
  const oldRecoveryCode = mfaCrypto.generateRecoveryCode();
  const oldRecoveryHash = mfaCrypto.hashRecoveryCode(oldRecoveryCode);
  const pendingSecret = mfaCrypto.generateTotpSecret();
  const pendingEnrollmentId = randomUUID();
  const outstandingChallengeHash = hashToken(randomUUID());

  await migrator.query(
    `INSERT INTO mfa_recovery_codes (id, user_id, code_hash)
     VALUES ($1, $2, $3)`,
    [randomUUID(), userId, oldRecoveryHash],
  );

  await migrator.query(
    `INSERT INTO mfa_enrollments (
       id, user_id, encrypted_secret, expires_at, updated_at
     )
     VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', NOW())`,
    [pendingEnrollmentId, userId, mfaCrypto.encryptSecret(pendingSecret)],
  );

  await migrator.query(
    `INSERT INTO mfa_challenges (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`,
    [randomUUID(), userId, outstandingChallengeHash],
  );

  const sessionBefore = await migrator.query(
    `SELECT id, revoked_at
     FROM auth_sessions
     WHERE user_id = $1 AND session_hash = $2`,
    [userId, hashToken(sessionToken)],
  );
  assert.equal(sessionBefore.rowCount, 1);
  assert.equal(sessionBefore.rows[0].revoked_at, null);

  // 1. Missing CSRF must not change any lifecycle state.
  const csrfFailure = await disableRequest({ password, currentCode }, null);
  assert.equal(csrfFailure.status, 403);

  // 2. Wrong password must not consume the valid TOTP step.
  const passwordFailure = await disableRequest({
    password: "incorrect-password",
    currentCode,
  });
  assert.equal(passwordFailure.status, 401);

  // 3. A valid password cannot compensate for an invalid factor.
  let invalidCode = "000000";
  while (mfaCrypto.verifyTotpCode(activeSecret, invalidCode, Date.now()) !== null) {
    invalidCode = String((Number(invalidCode) + 1) % 1000000).padStart(6, "0");
  }

  const factorFailure = await disableRequest({
    password,
    currentCode: invalidCode,
  });
  assert.equal(factorFailure.status, 401);

  const stateAfterFailures = await migrator.query(
    `SELECT
       m.status,
       m.enabled_at,
       m.last_accepted_time_step,
       s.revoked_at,
       r.consumed_at AS recovery_consumed_at,
       e.id AS enrollment_id,
       c.consumed_at AS challenge_consumed_at
     FROM user_mfa m
     JOIN auth_sessions s
       ON s.user_id = m.user_id AND s.session_hash = $2
     JOIN mfa_recovery_codes r
       ON r.user_id = m.user_id AND r.code_hash = $3
     JOIN mfa_enrollments e
       ON e.user_id = m.user_id
     JOIN mfa_challenges c
       ON c.user_id = m.user_id AND c.token_hash = $4
     WHERE m.user_id = $1`,
    [userId, hashToken(sessionToken), oldRecoveryHash, outstandingChallengeHash],
  );

  assert.equal(stateAfterFailures.rowCount, 1);
  assert.equal(stateAfterFailures.rows[0].status, "ENABLED");
  assert.ok(stateAfterFailures.rows[0].enabled_at);
  assert.equal(stateAfterFailures.rows[0].last_accepted_time_step, String(loginStep));
  assert.equal(stateAfterFailures.rows[0].revoked_at, null);
  assert.equal(stateAfterFailures.rows[0].recovery_consumed_at, null);
  assert.equal(stateAfterFailures.rows[0].enrollment_id, pendingEnrollmentId);
  assert.equal(stateAfterFailures.rows[0].challenge_consumed_at, null);

  // 4. A fresh password + TOTP disables MFA and invalidates every session.
  const success = await disableRequest({ password, currentCode });
  assert.equal(success.status, 200);
  assert.equal(success.headers.get("cache-control"), "no-store");

  const clearCookie = success.headers.get("set-cookie");
  assert.ok(clearCookie);
  assert.match(clearCookie, /Max-Age=0/i);

  const successBody = await success.json();
  assert.equal(successBody.message, "MFA disabled. Sign in again.");
  assert.ok(successBody.disabledAt);
  assert.ok(successBody.revokedSessions >= 1);

  const disabledMfa = await migrator.query(
    `SELECT status, enabled_at, last_accepted_time_step
     FROM user_mfa
     WHERE user_id = $1`,
    [userId],
  );
  assert.equal(disabledMfa.rowCount, 1);
  assert.equal(disabledMfa.rows[0].status, "DISABLED");
  assert.equal(disabledMfa.rows[0].enabled_at, null);
  assert.equal(disabledMfa.rows[0].last_accepted_time_step, null);

  const revokedSession = await migrator.query(
    `SELECT revoked_at
     FROM auth_sessions
     WHERE user_id = $1 AND session_hash = $2`,
    [userId, hashToken(sessionToken)],
  );
  assert.equal(revokedSession.rowCount, 1);
  assert.ok(revokedSession.rows[0].revoked_at);

  const invalidatedCredentials = await migrator.query(
    `SELECT
       (SELECT consumed_at FROM mfa_recovery_codes
        WHERE user_id = $1 AND code_hash = $2) AS recovery_consumed_at,
       (SELECT id FROM mfa_enrollments
        WHERE user_id = $1) AS enrollment_id,
       (SELECT consumed_at FROM mfa_challenges
        WHERE user_id = $1 AND token_hash = $3) AS challenge_consumed_at`,
    [userId, oldRecoveryHash, outstandingChallengeHash],
  );

  assert.equal(invalidatedCredentials.rowCount, 1);
  assert.ok(invalidatedCredentials.rows[0].recovery_consumed_at);
  assert.equal(invalidatedCredentials.rows[0].enrollment_id, null);
  assert.ok(invalidatedCredentials.rows[0].challenge_consumed_at);

  // The old browser session must no longer authenticate.
  const oldSessionResponse = await fetch(`${apiBaseUrl}/api/v1/auth/me`, {
    headers: {
      Origin: frontendOrigin,
      Cookie: cookieHeader(sessionToken),
    },
  });
  assert.equal(oldSessionResponse.status, 401);

  const audit = await migrator.query(
    `SELECT action, outcome, count(*)::int AS total
     FROM audit_events
     WHERE actor_user_id = $1
       AND action IN (
         'auth.mfa.disable_failed',
         'auth.mfa.disabled'
       )
     GROUP BY action, outcome`,
    [userId],
  );

  const successAudits = audit.rows.filter(
    (row) => row.action === "auth.mfa.disabled" && row.outcome === "SUCCESS",
  );
  assert.equal(successAudits.length, 1);
  assert.equal(successAudits[0].total, 1);

  const failureAudits = audit.rows.filter(
    (row) => row.action === "auth.mfa.disable_failed" && row.outcome === "FAILURE",
  );
  assert.ok(failureAudits.reduce((sum, row) => sum + row.total, 0) >= 2);
});

test("Active platform administrators cannot disable MFA or consume a TOTP step", async () => {
  const adminUserId = randomUUID();
  const adminEmail = `${adminUserId}@example.invalid`;
  const adminPassword = "integration-platform-admin-password";
  const adminSecret = mfaCrypto.generateTotpSecret();
  let fixtureCreated = false;

  try {
    const passwordHash = await passwords.hashPassword(adminPassword);

    await migrator.query(
      `INSERT INTO users (
         id, email_normalized, password_hash,
         email_verified_at, status, updated_at
       )
       VALUES ($1, $2, $3, NOW(), 'ACTIVE', NOW())`,
      [adminUserId, adminEmail, passwordHash],
    );
    fixtureCreated = true;

    await migrator.query(
      `INSERT INTO user_mfa (
         id, user_id, encrypted_secret, status, enabled_at, updated_at
       )
       VALUES ($1, $2, $3, 'ENABLED', NOW(), NOW())`,
      [randomUUID(), adminUserId, mfaCrypto.encryptSecret(adminSecret)],
    );

    await migrator.query(
      `INSERT INTO platform_administrators (
         id, user_id, role, status, updated_at
       )
       VALUES ($1, $2, 'PLATFORM_ADMIN', 'ACTIVE', NOW())`,
      [randomUUID(), adminUserId],
    );

    const baseStep = Math.floor(Date.now() / 30000);
    const loginStep = baseStep - 1;
    const disableStep = baseStep;

    const loginResponse = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: frontendOrigin,
      },
      body: JSON.stringify({
        email: adminEmail,
        password: adminPassword,
      }),
    });

    assert.equal(loginResponse.status, 200);
    const loginBody = await loginResponse.json();
    assert.equal(loginBody.mfaRequired, true);

    const verification = await verify(
      loginBody.challengeToken,
      mfaCrypto.generateTotpCode(adminSecret, loginStep),
    );

    assert.equal(verification.status, 200);
    const verificationBody = await verification.json();
    const sessionToken = getCookie(verification);
    const csrfToken = verificationBody.csrfToken;

    assert.match(csrfToken, /^[a-f0-9]{64}$/);

    const disableResponse = await fetch(`${apiBaseUrl}/api/v1/auth/mfa/disable`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: frontendOrigin,
        Cookie: cookieHeader(sessionToken),
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({
        password: adminPassword,
        currentCode: mfaCrypto.generateTotpCode(adminSecret, disableStep),
      }),
    });

    assert.equal(disableResponse.status, 401);
    assert.equal(disableResponse.headers.get("cache-control"), "no-store");

    const state = await migrator.query(
      `SELECT
         m.status,
         m.enabled_at,
         m.last_accepted_time_step,
         s.revoked_at
       FROM user_mfa m
       JOIN auth_sessions s
         ON s.user_id = m.user_id
        AND s.session_hash = $2
       WHERE m.user_id = $1`,
      [adminUserId, hashToken(sessionToken)],
    );

    assert.equal(state.rowCount, 1);
    assert.equal(state.rows[0].status, "ENABLED");
    assert.ok(state.rows[0].enabled_at);
    assert.equal(state.rows[0].last_accepted_time_step, String(loginStep));
    assert.equal(state.rows[0].revoked_at, null);

    const audit = await migrator.query(
      `SELECT action, outcome, count(*)::int AS total
       FROM audit_events
       WHERE actor_user_id = $1
         AND action = 'auth.mfa.disable_failed'
       GROUP BY action, outcome`,
      [adminUserId],
    );

    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].outcome, "FAILURE");
    assert.equal(audit.rows[0].total, 1);
  } finally {
    if (fixtureCreated) {
      await migrator.query("BEGIN");
      try {
        await migrator.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable");
        await migrator.query("DELETE FROM audit_events WHERE actor_user_id = $1", [adminUserId]);
        await migrator.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable");

        await migrator.query("DELETE FROM platform_administrators WHERE user_id = $1", [
          adminUserId,
        ]);
        await migrator.query("DELETE FROM mfa_challenges WHERE user_id = $1", [adminUserId]);
        await migrator.query("DELETE FROM mfa_enrollments WHERE user_id = $1", [adminUserId]);
        await migrator.query("DELETE FROM mfa_recovery_codes WHERE user_id = $1", [adminUserId]);
        await migrator.query("DELETE FROM user_mfa WHERE user_id = $1", [adminUserId]);
        await migrator.query("DELETE FROM auth_sessions WHERE user_id = $1", [adminUserId]);
        await migrator.query("DELETE FROM users WHERE id = $1", [adminUserId]);

        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    }
  }
});

async function createActivationFixture({ expired = false } = {}) {
  const id = randomUUID();
  const enrollmentId = randomUUID();
  const emailAddress = `${id}@example.invalid`;
  const secretValue = mfaCrypto.generateTotpSecret();
  const encryptedSecret = mfaCrypto.encryptSecret(secretValue);
  const passwordHash = await passwords.hashPassword(password);

  await migrator.query(
    `INSERT INTO users (
       id, email_normalized, password_hash,
       email_verified_at, status, updated_at
     )
     VALUES ($1, $2, $3, NOW(), 'ACTIVE', NOW())`,
    [id, emailAddress, passwordHash],
  );

  if (expired) {
    await migrator.query(
      `INSERT INTO mfa_enrollments (
         id, user_id, encrypted_secret,
         created_at, expires_at, updated_at
       )
       VALUES (
         $1, $2, $3,
         NOW() - INTERVAL '2 minutes',
         NOW() - INTERVAL '1 minute',
         NOW()
       )`,
      [enrollmentId, id, encryptedSecret],
    );
  } else {
    await migrator.query(
      `INSERT INTO mfa_enrollments (
         id, user_id, encrypted_secret,
         expires_at, updated_at
       )
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes', NOW())`,
      [enrollmentId, id, encryptedSecret],
    );
  }

  return {
    userId: id,
    enrollmentId,
    encryptedSecret,
  };
}

async function activateEnrollment({ contextUserId, userId, enrollmentId, timeStep }) {
  await appClient.query("BEGIN");

  try {
    await appClient.query(
      `SELECT
         set_config('app.user_id', $1, true),
         set_config('app.tenant_id', '', true)`,
      [contextUserId],
    );

    const result = await appClient.query(
      `SELECT public.activate_mfa_enrollment(
         $1::uuid,
         $2::uuid,
         $3::bigint
       ) AS enabled_at`,
      [userId, enrollmentId, timeStep],
    );

    await appClient.query("COMMIT");
    return result.rows[0].enabled_at;
  } catch (error) {
    await appClient.query("ROLLBACK");
    throw error;
  }
}

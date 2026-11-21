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
  assert.ok(process.env.MFA_ENCRYPTION_KEY);

  migrator = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await migrator.connect();

  const identity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(identity.rows[0].role, "serviceflow_migrator");
  assert.equal(identity.rows[0].database, "serviceflow_dev");

  appClient = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await appClient.connect();

  const runtimeIdentity = await appClient.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(runtimeIdentity.rows[0].role, "serviceflow_app");
  assert.equal(runtimeIdentity.rows[0].database, "serviceflow_dev");

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
  assert.equal(appIdentity[0].database, "serviceflow_dev");

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
        await migrator.query(
          "ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable",
        );

        await migrator.query(
          "DELETE FROM audit_events WHERE actor_user_id = $1",
          [userId],
        );

        await migrator.query(
          "ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable",
        );

        await migrator.query("DELETE FROM mfa_challenges WHERE user_id = $1", [userId]);
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
        [
          randomUUID(),
          candidateUserId,
          Buffer.alloc(32),
        ],
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
        [
          randomUUID(),
          candidateUserId,
          Buffer.alloc(32),
        ],
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
      const code = mfaCrypto.generateTotpCode(
        secret,
        Math.floor(Date.now() / 30000),
      );

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

  const code = mfaCrypto.generateTotpCode(
    secret,
    Math.floor(Date.now() / 30000),
  );
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
  const code = mfaCrypto.generateTotpCode(
    secret,
    Math.floor(Date.now() / 30000),
  );

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
  const code = mfaCrypto.generateTotpCode(
    secret,
    Math.floor(Date.now() / 30000),
  );

  const sessionsBefore = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  await migrator.query(
    "UPDATE users SET status = 'SUSPENDED', updated_at = NOW() WHERE id = $1",
    [userId],
  );

  let response;
  try {
    response = await verify(challengeToken, code);
  } finally {
    await migrator.query(
      "UPDATE users SET status = 'ACTIVE', updated_at = NOW() WHERE id = $1",
      [userId],
    );
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
  const code = mfaCrypto.generateTotpCode(
    secret,
    Math.floor(Date.now() / 30000),
  );

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

  await migrator.query(
    "UPDATE user_mfa SET last_accepted_time_step = NULL WHERE user_id = $1",
    [userId],
  );

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
    [userId, (await migrator.query(
      "SELECT id FROM mfa_challenges WHERE token_hash = $1",
      [tokenHash],
    )).rows[0].id],
  );
  assert.equal(failureAudit.rows[0].total, 2);

  const sessionsAfterFailures = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );
  assert.equal(
    sessionsAfterFailures.rows[0].total,
    sessionsBefore.rows[0].total,
  );

  const validCode = mfaCrypto.generateTotpCode(
    secret,
    Math.floor(Date.now() / 30000),
  );
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
  await migrator.query(
    "UPDATE user_mfa SET last_accepted_time_step = NULL WHERE user_id = $1",
    [userId],
  );

  const challengeToken = await createChallenge();
  const currentStep = Math.floor(Date.now() / 30000);
  const code = mfaCrypto.generateTotpCode(secret, currentStep);

  const sessionsBefore = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  const responses = await Promise.all([
    verify(challengeToken, code),
    verify(challengeToken, code),
  ]);

  const statuses = responses.map((response) => response.status).sort();
  assert.deepEqual(statuses, [200, 401]);

  const successfulResponses = responses.filter(
    (response) => response.status === 200,
  );
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
  await migrator.query(
    "UPDATE user_mfa SET last_accepted_time_step = NULL WHERE user_id = $1",
    [userId],
  );

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

  const successfulResponses = responses.filter(
    (response) => response.status === 200,
  );
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

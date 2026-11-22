import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";
import { AppModule } from "../dist/app.module.js";
import { PrismaService } from "../dist/database/prisma.service.js";
import { SessionService } from "../dist/identity/session.service.js";

const userId = randomUUID();
const email = `${userId}@example.invalid`;

let app;
let migrator;
let sessions;
let fixturesCreated = false;

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function enableMfa(enabledAt) {
  await migrator.query(
    `INSERT INTO user_mfa
       (id, user_id, encrypted_secret, status, enabled_at, updated_at)
     VALUES ($1, $2, $3, 'ENABLED', $4, NOW())`,
    [randomUUID(), userId, Buffer.alloc(29, 1), enabledAt],
  );
}

async function createPlatformAdministrator({
  status = "ACTIVE",
  revoked = false,
} = {}) {
  await migrator.query(
    `INSERT INTO platform_administrators (
       id, user_id, role, status,
       revoked_by_user_id, revoked_at, updated_at
     )
     VALUES ($1, $2, 'PLATFORM_ADMIN', $3, $4, $5, NOW())`,
    [
      randomUUID(),
      userId,
      status,
      revoked ? userId : null,
      revoked ? new Date() : null,
    ],
  );
}

async function deletePlatformAdministrator() {
  await migrator.query(
    "DELETE FROM platform_administrators WHERE user_id = $1",
    [userId],
  );
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  assert.ok(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL is required");

  migrator = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await migrator.connect();

  const identity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(identity.rows[0].role, "serviceflow_migrator");
  assert.equal(identity.rows[0].database, "serviceflow_dev");

  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  const prisma = app.get(PrismaService);
  sessions = app.get(SessionService);

  const appIdentity = await prisma.$queryRaw`
    SELECT current_user AS role, current_database() AS database
  `;
  assert.equal(appIdentity[0].role, "serviceflow_app");
  assert.equal(appIdentity[0].database, "serviceflow_dev");

  await migrator.query(
    `INSERT INTO users
       (id, email_normalized, password_hash, display_name, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [userId, email, "test-only-not-a-real-password-hash", "Session Integration User"],
  );

  fixturesCreated = true;
});

after(async () => {
  try {
    if (migrator && fixturesCreated) {
      await migrator.query("BEGIN");
      try {
        await migrator.query(
          "DELETE FROM platform_administrators WHERE user_id = $1",
          [userId],
        );
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
    if (app) {
      await app.close();
    }
    if (migrator) {
      await migrator.end();
    }
  }
});

test("Session creation stores only a SHA-256 hash of the opaque secret", async () => {
  const created = await sessions.createSession(userId, "ServiceFlow integration test");

  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(created.expiresAt instanceof Date);

  const lifetime = created.expiresAt.getTime() - Date.now();
  assert.ok(
    Math.abs(lifetime - 12 * 60 * 60 * 1000) < 5000,
    "Session must expire approximately 12 hours after creation",
  );

  const result = await migrator.query(
    `SELECT session_hash, expires_at, user_agent
     FROM auth_sessions
     WHERE user_id = $1 AND session_hash = $2`,
    [userId, hashToken(created.token)],
  );

  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].session_hash, hashToken(created.token));
  assert.notEqual(result.rows[0].session_hash, created.token);
  assert.equal(result.rows[0].user_agent, "ServiceFlow integration test");
  assert.deepEqual(Object.keys(created).sort(), ["expiresAt", "token"]);
});

test("Session validation accepts valid credentials and rejects invalid ones", async () => {
  const created = await sessions.createSession(userId);

  const validated = await sessions.validateSession(created.token);

  assert.ok(validated);
  assert.equal(validated.userId, userId);
  assert.ok(validated.sessionId);
  assert.equal(validated.expiresAt.getTime(), created.expiresAt.getTime());

  assert.equal(await sessions.validateSession("invalid-token"), null);
  assert.equal(await sessions.validateSession(""), null);
});

test("Session revocation immediately invalidates the credential", async () => {
  const created = await sessions.createSession(userId);

  assert.equal(await sessions.revokeSession(created.token), true);
  assert.equal(await sessions.validateSession(created.token), null);
  assert.equal(await sessions.revokeSession(created.token), false);
});

test("Expired sessions cannot be validated", async () => {
  const created = await sessions.createSession(userId);

  const expiredUpdate = await migrator.query(
    `UPDATE auth_sessions
     SET created_at = NOW() - INTERVAL '2 days',
         expires_at = NOW() - INTERVAL '1 day'
     WHERE session_hash = $1`,
    [hashToken(created.token)],
  );

  assert.equal(expiredUpdate.rowCount, 1);

  const storedExpiry = await migrator.query(
    "SELECT expires_at < NOW() AS is_expired FROM auth_sessions WHERE session_hash = $1",
    [hashToken(created.token)],
  );

  assert.equal(storedExpiry.rows[0].is_expired, true);
  assert.equal(await sessions.validateSession(created.token), null);
});

test("Inactive users cannot validate or create sessions", async () => {
  const created = await sessions.createSession(userId);

  try {
    await migrator.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [userId]);

    assert.equal(await sessions.validateSession(created.token), null);

    await assert.rejects(sessions.createSession(userId), (error) => error?.getStatus?.() === 401);
  } finally {
    await migrator.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userId]);
  }
});

test("Logout-all revokes every active session belonging to the user", async () => {
  const baseline = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1 AND revoked_at IS NULL",
    [userId],
  );

  const created = await Promise.all([
    sessions.createSession(userId),
    sessions.createSession(userId),
    sessions.createSession(userId),
  ]);

  assert.equal(await sessions.revokeAllSessions(userId), baseline.rows[0].total + created.length);
  assert.equal(await sessions.revokeAllSessions(userId), 0);

  for (const session of created) {
    assert.equal(await sessions.validateSession(session.token), null);
  }
});

test("Session rotation invalidates the old credential and creates a replacement", async () => {
  const original = await sessions.createSession(userId);

  const replacement = await sessions.rotateSession(original.token, "ServiceFlow rotated session");

  assert.ok(replacement);
  assert.notEqual(replacement.token, original.token);
  assert.equal(await sessions.validateSession(original.token), null);

  const validated = await sessions.validateSession(replacement.token);
  assert.ok(validated);
  assert.equal(validated.userId, userId);

  const oldRecord = await migrator.query(
    "SELECT revoked_at FROM auth_sessions WHERE session_hash = $1",
    [hashToken(original.token)],
  );
  assert.ok(oldRecord.rows[0].revoked_at);
});

test("Concurrent rotation attempts produce exactly one replacement", async () => {
  const original = await sessions.createSession(userId);

  const results = await Promise.all([
    sessions.rotateSession(original.token),
    sessions.rotateSession(original.token),
  ]);

  const replacements = results.filter((result) => result !== null);

  assert.equal(replacements.length, 1);
  assert.equal(await sessions.validateSession(original.token), null);
  assert.ok(await sessions.validateSession(replacements[0].token));
});

test("MFA-enabled users cannot create password-only sessions", async () => {
  const enabledAt = new Date(Date.now() - 60_000);
  const before = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  await enableMfa(enabledAt);

  try {
    await assert.rejects(
      sessions.createSession(userId),
      (error) => error?.getStatus?.() === 401,
    );

    const after = await migrator.query(
      "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
      [userId],
    );

    assert.equal(after.rows[0].total, before.rows[0].total);
  } finally {
    await migrator.query("DELETE FROM user_mfa WHERE user_id = $1", [userId]);
  }
});

test("Active platform administrators cannot create password-only sessions", async () => {
  const before = await migrator.query(
    "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
    [userId],
  );

  await createPlatformAdministrator();

  try {
    await assert.rejects(
      sessions.createSession(userId),
      (error) => error?.getStatus?.() === 401,
    );

    const after = await migrator.query(
      "SELECT count(*)::int AS total FROM auth_sessions WHERE user_id = $1",
      [userId],
    );

    assert.equal(after.rows[0].total, before.rows[0].total);
  } finally {
    await deletePlatformAdministrator();
  }
});

test("Active platform administrators cannot validate or rotate sessions without MFA", async () => {
  const original = await sessions.createSession(userId);

  await createPlatformAdministrator();

  try {
    assert.equal(await sessions.validateSession(original.token), null);
    assert.equal(await sessions.rotateSession(original.token), null);

    const stored = await migrator.query(
      "SELECT revoked_at FROM auth_sessions WHERE session_hash = $1",
      [hashToken(original.token)],
    );

    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].revoked_at, null);
  } finally {
    await deletePlatformAdministrator();
  }
});

test("Suspended and revoked platform administrator grants do not enforce MFA", async () => {
  const suspendedSession = await sessions.createSession(userId);

  await createPlatformAdministrator({ status: "SUSPENDED" });

  try {
    assert.ok(await sessions.validateSession(suspendedSession.token));

    const rotated = await sessions.rotateSession(suspendedSession.token);
    assert.ok(rotated);
    assert.ok(await sessions.validateSession(rotated.token));
  } finally {
    await deletePlatformAdministrator();
  }

  const revokedSession = await sessions.createSession(userId);

  await createPlatformAdministrator({
    status: "SUSPENDED",
    revoked: true,
  });

  try {
    assert.ok(await sessions.validateSession(revokedSession.token));

    const rotated = await sessions.rotateSession(revokedSession.token);
    assert.ok(rotated);
    assert.ok(await sessions.validateSession(rotated.token));
  } finally {
    await deletePlatformAdministrator();
  }
});

test("Active platform administrators cannot use old MFA sessions after MFA is disabled", async () => {
  const original = await sessions.createSession(userId);
  const enabledAt = new Date(Date.now() - 60_000);

  await enableMfa(enabledAt);

  try {
    await migrator.query(
      `UPDATE auth_sessions
       SET mfa_verified_at = $1
       WHERE session_hash = $2`,
      [enabledAt, hashToken(original.token)],
    );

    await migrator.query(
      "UPDATE user_mfa SET status = 'DISABLED' WHERE user_id = $1",
      [userId],
    );

    await createPlatformAdministrator();

    assert.equal(await sessions.validateSession(original.token), null);
    assert.equal(await sessions.rotateSession(original.token), null);

    const stored = await migrator.query(
      "SELECT revoked_at FROM auth_sessions WHERE session_hash = $1",
      [hashToken(original.token)],
    );

    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0].revoked_at, null);
  } finally {
    await deletePlatformAdministrator();
    await migrator.query("DELETE FROM user_mfa WHERE user_id = $1", [userId]);
  }
});

test("MFA enforcement rejects sessions verified before MFA enablement", async () => {
  const original = await sessions.createSession(userId);
  const enabledAt = new Date(Date.now() - 60_000);

  await enableMfa(enabledAt);

  try {
    await migrator.query(
      `UPDATE auth_sessions
       SET mfa_verified_at = $1
       WHERE session_hash = $2`,
      [new Date(enabledAt.getTime() - 1_000), hashToken(original.token)],
    );

    assert.equal(await sessions.validateSession(original.token), null);

    await migrator.query(
      `UPDATE auth_sessions
       SET mfa_verified_at = $1
       WHERE session_hash = $2`,
      [enabledAt, hashToken(original.token)],
    );

    const validated = await sessions.validateSession(original.token);
    assert.ok(validated);
    assert.equal(validated.userId, userId);
  } finally {
    await migrator.query("DELETE FROM user_mfa WHERE user_id = $1", [userId]);
  }
});

test("MFA session rotation rejects unverified sessions and preserves verified timestamps", async () => {
  const original = await sessions.createSession(userId);
  const enabledAt = new Date(Date.now() - 60_000);

  await enableMfa(enabledAt);

  try {
    assert.equal(await sessions.rotateSession(original.token), null);

    const unchanged = await migrator.query(
      "SELECT revoked_at FROM auth_sessions WHERE session_hash = $1",
      [hashToken(original.token)],
    );
    assert.equal(unchanged.rows[0].revoked_at, null);

    await migrator.query(
      `UPDATE auth_sessions
       SET mfa_verified_at = $1
       WHERE session_hash = $2`,
      [enabledAt, hashToken(original.token)],
    );

    const replacement = await sessions.rotateSession(original.token);
    assert.ok(replacement);

    const stored = await migrator.query(
      "SELECT mfa_verified_at FROM auth_sessions WHERE session_hash = $1",
      [hashToken(replacement.token)],
    );

    assert.equal(
      new Date(stored.rows[0].mfa_verified_at).getTime(),
      enabledAt.getTime(),
    );

    assert.ok(await sessions.validateSession(replacement.token));
  } finally {
    await migrator.query("DELETE FROM user_mfa WHERE user_id = $1", [userId]);
  }
});

import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";

import { AppModule } from "../dist/app.module.js";
import { PrismaService } from "../dist/database/prisma.service.js";
import { GlobalIdentityContextService } from "../dist/database/global-identity-context.service.js";

const userA = randomUUID();
const userB = randomUUID();

const challengeTokenA = randomBytes(32).toString("base64url");
const challengeTokenB = randomBytes(32).toString("base64url");

const challengeHashA = createHash("sha256").update(challengeTokenA).digest("hex");
const challengeHashB = createHash("sha256").update(challengeTokenB).digest("hex");

const recoveryHashA = createHash("sha256").update(randomBytes(32)).digest("hex");
const recoveryHashB = createHash("sha256").update(randomBytes(32)).digest("hex");

const mfaIdA = randomUUID();
const mfaIdB = randomUUID();
const recoveryIdA = randomUUID();
const recoveryIdB = randomUUID();
const challengeIdA = randomUUID();
const challengeIdB = randomUUID();

let app;
let migrator;
let identityContext;
let prisma;
let fixturesCreated = false;

async function createFixtures() {
  await migrator.query("BEGIN");

  try {
    for (const [id, suffix] of [
      [userA, "A"],
      [userB, "B"],
    ]) {
      await migrator.query(
        `INSERT INTO users
          (id, email_normalized, password_hash, display_name, updated_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          id,
          `${id}@example.invalid`,
          "test-only-not-a-real-password-hash",
          `MFA Test User ${suffix}`,
        ],
      );
    }

    for (const [id, userId] of [
      [mfaIdA, userA],
      [mfaIdB, userB],
    ]) {
      await migrator.query(
        `INSERT INTO user_mfa
          (id, user_id, encrypted_secret, status, enabled_at, updated_at)
         VALUES ($1, $2, $3, 'ENABLED', NOW(), NOW())`,
        [id, userId, Buffer.alloc(32, 7)],
      );
    }

    for (const [id, userId, codeHash] of [
      [recoveryIdA, userA, recoveryHashA],
      [recoveryIdB, userB, recoveryHashB],
    ]) {
      await migrator.query(
        `INSERT INTO mfa_recovery_codes (id, user_id, code_hash)
         VALUES ($1, $2, $3)`,
        [id, userId, codeHash],
      );
    }

    for (const [id, userId, tokenHash] of [
      [challengeIdA, userA, challengeHashA],
      [challengeIdB, userB, challengeHashB],
    ]) {
      await migrator.query(
        `INSERT INTO mfa_challenges
          (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`,
        [id, userId, tokenHash],
      );
    }

    await migrator.query("COMMIT");
  } catch (error) {
    await migrator.query("ROLLBACK");
    throw error;
  }
}

async function cleanupFixtures() {
  await migrator.query("BEGIN");

  try {
    await migrator.query("DELETE FROM mfa_challenges WHERE user_id = ANY($1::uuid[])", [
      [userA, userB],
    ]);
    await migrator.query("DELETE FROM mfa_recovery_codes WHERE user_id = ANY($1::uuid[])", [
      [userA, userB],
    ]);
    await migrator.query("DELETE FROM user_mfa WHERE user_id = ANY($1::uuid[])", [[userA, userB]]);
    await migrator.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [[userA, userB]]);
    await migrator.query("COMMIT");
  } catch (error) {
    await migrator.query("ROLLBACK");
    throw error;
  }
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  assert.ok(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL is required");

  migrator = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();

  const migrationIdentity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(migrationIdentity.rows[0].role, "serviceflow_migrator");
  assert.equal(migrationIdentity.rows[0].database, "serviceflow_test");

  app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  prisma = app.get(PrismaService);
  identityContext = app.get(GlobalIdentityContextService);

  const appIdentity = await prisma.$queryRaw`
    SELECT current_user AS role, current_database() AS database
  `;
  assert.equal(appIdentity[0].role, "serviceflow_app");
  assert.equal(appIdentity[0].database, "serviceflow_test");

  await createFixtures();
  fixturesCreated = true;
});

after(async () => {
  try {
    if (migrator && fixturesCreated) {
      await cleanupFixtures();
    }
  } finally {
    if (app) await app.close();
    if (migrator) await migrator.end();
  }
});

test("Global identity context isolates MFA configuration and recovery codes by user", async () => {
  await identityContext.withGlobalIdentityContext({ userId: userA }, async (tx) => {
    const mfaRows = await tx.$queryRaw`
      SELECT user_id FROM user_mfa ORDER BY user_id
    `;
    const recoveryRows = await tx.$queryRaw`
      SELECT user_id FROM mfa_recovery_codes ORDER BY user_id
    `;

    assert.deepEqual(
      mfaRows.map((row) => row.user_id),
      [userA],
    );
    assert.deepEqual(
      recoveryRows.map((row) => row.user_id),
      [userA],
    );
  });

  await identityContext.withGlobalIdentityContext({ userId: userB }, async (tx) => {
    const mfaRows = await tx.$queryRaw`
      SELECT user_id FROM user_mfa ORDER BY user_id
    `;
    const recoveryRows = await tx.$queryRaw`
      SELECT user_id FROM mfa_recovery_codes ORDER BY user_id
    `;

    assert.deepEqual(
      mfaRows.map((row) => row.user_id),
      [userB],
    );
    assert.deepEqual(
      recoveryRows.map((row) => row.user_id),
      [userB],
    );
  });
});

test("Challenge hash discovers only its matching challenge before user context is known", async () => {
  await identityContext.withGlobalIdentityContext(
    { challengeTokenHash: challengeHashA },
    async (tx) => {
      const rows = await tx.$queryRaw`
        SELECT id, user_id
        FROM mfa_challenges
        ORDER BY id
      `;

      assert.deepEqual(rows, [{ id: challengeIdA, user_id: userA }]);
    },
  );
});

test("Challenge consumption requires both matching challenge hash and user context", async () => {
  await identityContext.withGlobalIdentityContext(
    { challengeTokenHash: challengeHashA },
    async (tx) => {
      await identityContext.setUserContext(tx, userB);

      const foreignConsumption = await tx.$executeRaw`
        UPDATE mfa_challenges
        SET consumed_at = NOW()
        WHERE id = ${challengeIdA}::uuid
          AND consumed_at IS NULL
      `;

      assert.equal(foreignConsumption, 0);
    },
  );

  await identityContext.withGlobalIdentityContext(
    { challengeTokenHash: challengeHashA },
    async (tx) => {
      const discovered = await tx.$queryRaw`
        SELECT id, user_id
        FROM mfa_challenges
        WHERE token_hash = ${challengeHashA}
      `;

      assert.equal(discovered.length, 1);
      assert.equal(discovered[0].user_id, userA);

      await identityContext.setUserContext(tx, discovered[0].user_id);

      const consumption = await tx.$executeRaw`
        UPDATE mfa_challenges
        SET consumed_at = NOW()
        WHERE id = ${challengeIdA}::uuid
          AND consumed_at IS NULL
      `;

      assert.equal(consumption, 1);
    },
  );

  const stored = await migrator.query(
    "SELECT consumed_at IS NOT NULL AS consumed FROM mfa_challenges WHERE id = $1",
    [challengeIdA],
  );
  assert.equal(stored.rows[0].consumed, true);
});

test("Global identity settings do not leak outside their transaction", async () => {
  await identityContext.withGlobalIdentityContext(
    { challengeTokenHash: challengeHashB },
    async (tx) => {
      const settings = await tx.$queryRaw`
        SELECT
          current_setting('app.user_id', true) AS user_id,
          current_setting('app.tenant_id', true) AS tenant_id,
          current_setting('app.mfa_challenge_hash', true) AS challenge_hash
      `;

      assert.equal(settings[0].user_id, "");
      assert.equal(settings[0].tenant_id, "");
      assert.equal(settings[0].challenge_hash, challengeHashB);
    },
  );

  const outside = await prisma.$queryRaw`
    SELECT
      current_setting('app.user_id', true) AS user_id,
      current_setting('app.tenant_id', true) AS tenant_id,
      current_setting('app.mfa_challenge_hash', true) AS challenge_hash
  `;

  for (const value of Object.values(outside[0])) {
    assert.ok(
      value == null || value === "",
      "Identity settings must not persist outside the transaction",
    );
  }
});

test("Global identity context rejects malformed or empty identity options", async () => {
  await assert.rejects(
    identityContext.withGlobalIdentityContext({ userId: "not-a-uuid" }, async () => {}),
    (error) => error?.getStatus?.() === 400,
  );

  await assert.rejects(
    identityContext.withGlobalIdentityContext(
      { challengeTokenHash: "not-a-sha256-hash" },
      async () => {},
    ),
    (error) => error?.getStatus?.() === 400,
  );

  await assert.rejects(
    identityContext.withGlobalIdentityContext({}, async () => {}),
    (error) => error?.getStatus?.() === 400,
  );
});

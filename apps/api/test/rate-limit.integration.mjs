import "dotenv/config";

import assert from "node:assert/strict";

import { createHmac, randomUUID } from "node:crypto";

import { after, before, test } from "node:test";

import { NestFactory } from "@nestjs/core";

import { Client } from "pg";

import { AppModule } from "../dist/app.module.js";

import { PrismaService } from "../dist/database/prisma.service.js";

import { RateLimitService } from "../dist/rate-limit/rate-limit.service.js";

let app;

let migrator;

let rateLimiter;

const fixtureHashes = new Set();

function createInput(overrides = {}) {
  return {
    operation: "integration-test",
    dimension: "identifier",
    identifier: `rate-limit-test-${randomUUID()}`,
    limit: 2,
    windowSeconds: 3600,
    ...overrides,
  };
}

function hashInput(input) {
  const secret = process.env.RATE_LIMIT_HMAC_SECRET;

  assert.match(secret ?? "", /^[0-9a-f]{64}$/);

  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(
      `v1\0${input.operation}\0${input.dimension}\0${input.windowSeconds}\0${input.identifier}`,
    )
    .digest("hex");
}

function trackFixture(input) {
  const hash = hashInput(input);
  fixtureHashes.add(hash);
  return hash;
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  assert.ok(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL is required");
  assert.match(
    process.env.RATE_LIMIT_HMAC_SECRET ?? "",
    /^[0-9a-f]{64}$/,
    "RATE_LIMIT_HMAC_SECRET must be a 256-bit lowercase hexadecimal value",
  );

  migrator = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });

  await migrator.connect();

  const identity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );

  assert.equal(identity.rows[0].role, "serviceflow_migrator");
  assert.equal(identity.rows[0].database, "serviceflow_test");

  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  const prisma = app.get(PrismaService);
  rateLimiter = app.get(RateLimitService);

  const appIdentity = await prisma.$queryRaw`
    SELECT current_user AS role, current_database() AS database
  `;

  assert.equal(appIdentity[0].role, "serviceflow_app");
  assert.equal(appIdentity[0].database, "serviceflow_test");
});

after(async () => {
  try {
    if (migrator && fixtureHashes.size > 0) {
      await migrator.query(
        `DELETE FROM rate_limit_buckets
         WHERE rtrim(key_hash) = ANY($1::text[])`,
        [[...fixtureHashes]],
      );
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

test("Rate limits allow requests up to the configured threshold", async () => {
  const input = createInput({ limit: 2 });
  const expectedHash = trackFixture(input);

  const first = await rateLimiter.consume(input);
  const second = await rateLimiter.consume(input);
  const third = await rateLimiter.consume(input);
  const fourth = await rateLimiter.consume(input);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(third.allowed, false);
  assert.equal(fourth.allowed, false);

  for (const result of [first, second, third, fourth]) {
    assert.ok(result.retryAfterSeconds >= 1);
    assert.ok(result.retryAfterSeconds <= input.windowSeconds);
  }

  const stored = await migrator.query(
    `SELECT key_hash, hit_count
     FROM rate_limit_buckets
     WHERE rtrim(key_hash) = $1
     ORDER BY window_start DESC
     LIMIT 1`,
    [expectedHash],
  );

  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].key_hash.trim(), expectedHash);
  assert.equal(stored.rows[0].hit_count, 3);
  assert.notEqual(stored.rows[0].key_hash.trim(), input.identifier);
});

test("Independent operations, dimensions, and identifiers have separate counters", async () => {
  const original = createInput({ limit: 1 });
  const differentOperation = {
    ...original,
    operation: "different-operation",
  };
  const differentDimension = {
    ...original,
    dimension: "different-dimension",
  };
  const differentIdentifier = {
    ...original,
    identifier: `${original.identifier}-different`,
  };

  for (const input of [original, differentOperation, differentDimension, differentIdentifier]) {
    trackFixture(input);
  }

  assert.equal((await rateLimiter.consume(original)).allowed, true);
  assert.equal((await rateLimiter.consume(original)).allowed, false);

  assert.equal((await rateLimiter.consume(differentOperation)).allowed, true);
  assert.equal((await rateLimiter.consume(differentDimension)).allowed, true);
  assert.equal((await rateLimiter.consume(differentIdentifier)).allowed, true);
});

test("Concurrent requests cannot exceed the configured allowance", async () => {
  const input = createInput({ limit: 4 });
  trackFixture(input);

  const results = await Promise.all(Array.from({ length: 20 }, () => rateLimiter.consume(input)));

  const allowed = results.filter((result) => result.allowed);
  const rejected = results.filter((result) => !result.allowed);

  assert.equal(allowed.length, 4);
  assert.equal(rejected.length, 16);

  for (const result of results) {
    assert.ok(result.retryAfterSeconds >= 1);
    assert.ok(result.retryAfterSeconds <= input.windowSeconds);
  }
});

test("Invalid rate-limit configurations are rejected", async () => {
  const validInput = createInput();

  const invalidInputs = [
    { ...validInput, operation: "" },
    { ...validInput, dimension: "" },
    { ...validInput, identifier: "" },
    { ...validInput, limit: 0 },
    { ...validInput, limit: -1 },
    { ...validInput, limit: 1.5 },
    { ...validInput, windowSeconds: 0 },
    { ...validInput, windowSeconds: -1 },
    { ...validInput, windowSeconds: 1.5 },
  ];

  for (const input of invalidInputs) {
    await assert.rejects(rateLimiter.consume(input), (error) => error instanceof RangeError);
  }
});

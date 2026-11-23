import "dotenv/config";

import assert from "node:assert/strict";
import { ValidationPipe } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { Test } from "@nestjs/testing";
import { Client } from "pg";

import { AppModule } from "../dist/app.module.js";
import { PrismaService } from "../dist/database/prisma.service.js";
import { AuthService } from "../dist/identity/auth.service.js";
import { EmailDeliveryService } from "../dist/identity/email-delivery.service.js";
import { PasswordService } from "../dist/identity/password.service.js";
import { RateLimitService } from "../dist/rate-limit/rate-limit.service.js";

const successfulEmail = `${randomUUID()}@example.invalid`;
const duplicateEmail = `${randomUUID()}@example.invalid`;
const failedDeliveryEmail = `${randomUUID()}@example.invalid`;
const expiredVerificationEmail = `${randomUUID()}@example.invalid`;
const concurrentVerificationEmail = `${randomUUID()}@example.invalid`;
const alreadyVerifiedEmail = `${randomUUID()}@example.invalid`;
const httpRegistrationEmail = `${randomUUID()}@example.invalid`;
const resendVerificationEmail = `${randomUUID()}@example.invalid`;
const resendDeliveryFailureEmail = `${randomUUID()}@example.invalid`;
const concurrentResendEmail = `${randomUUID()}@example.invalid`;

const verificationResendRaceEmail = `${randomUUID()}@example.invalid`;
const passwordResetEmail = `${randomUUID()}@example.invalid`;

const fixtureEmails = [
  successfulEmail,
  duplicateEmail,
  failedDeliveryEmail,
  expiredVerificationEmail,
  concurrentVerificationEmail,
  alreadyVerifiedEmail,
  httpRegistrationEmail,
  resendVerificationEmail,
  resendDeliveryFailureEmail,
  concurrentResendEmail,
  verificationResendRaceEmail,
  passwordResetEmail,
];

const registrationResponse = {
  message:
    "If registration is possible, verification instructions will be sent to the provided email address.",
};

let app;
let migrator;
let auth;
let passwords;
let successfulVerificationToken;
let apiBaseUrl;
let deliveryFailure = false;
let blockedRateLimit = null;

const deliveryAttempts = [];
const passwordResetDeliveryAttempts = [];
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

const emailProvider = {
  async sendVerificationEmail(email, verificationUrl) {
    deliveryAttempts.push({ email, verificationUrl });

    if (deliveryFailure) {
      throw new Error("Simulated email delivery failure");
    }
  },
  async sendPasswordResetEmail(email, resetUrl) {
    passwordResetDeliveryAttempts.push({ email, resetUrl });
    if (deliveryFailure) throw new Error("Simulated email delivery failure");
  },
};

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  assert.ok(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL is required");
  assert.ok(process.env.WEB_APP_URL, "WEB_APP_URL is required");

  migrator = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });

  await migrator.connect();

  const migrationIdentity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );

  assert.equal(migrationIdentity.rows[0].role, "serviceflow_migrator");
  assert.equal(migrationIdentity.rows[0].database, "serviceflow_test");

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(EmailDeliveryService)
    .useValue(emailProvider)
    .overrideProvider(RateLimitService)
    .useValue(rateLimitProvider)
    .compile();

  app = moduleRef.createNestApplication();

  app.setGlobalPrefix("api/v1");
  app.enableCors({
    origin: (requestOrigin, callback) =>
      callback(null, requestOrigin === new URL(process.env.WEB_APP_URL).origin),
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  });
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
    throw new Error("Could not determine the integration test server address.");
  }
  apiBaseUrl = `http://127.0.0.1:${address.port}`;

  const prisma = app.get(PrismaService);
  auth = app.get(AuthService);
  passwords = app.get(PasswordService);

  const appIdentity = await prisma.$queryRaw`
    SELECT current_user AS role, current_database() AS database
  `;

  assert.equal(appIdentity[0].role, "serviceflow_app");
  assert.equal(appIdentity[0].database, "serviceflow_test");
});

after(async () => {
  try {
    if (migrator) {
      await migrator.query(
        `DELETE FROM users
         WHERE email_normalized = ANY($1::text[])
           AND id NOT IN (SELECT actor_user_id FROM audit_events WHERE actor_user_id IS NOT NULL)`,
        [fixtureEmails],
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

test("Registration normalizes email and stores password and verification-token hashes", async () => {
  const password = "registration-test-password";

  const response = await auth.register({
    email: `  ${successfulEmail.toUpperCase()}  `,
    password,
    displayName: "Registration Integration User",
  });

  assert.deepEqual(response, registrationResponse);
  assert.equal(deliveryAttempts.length, 1);
  assert.equal(deliveryAttempts[0].email, successfulEmail);

  const verificationUrl = new URL(deliveryAttempts[0].verificationUrl);
  const rawToken = verificationUrl.searchParams.get("token");
  successfulVerificationToken = rawToken;

  assert.match(rawToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(verificationUrl.pathname, "/verify-email");

  const userResult = await migrator.query(
    `SELECT id, email_normalized, password_hash, display_name,
            email_verified_at, status
     FROM users
     WHERE email_normalized = $1`,
    [successfulEmail],
  );

  assert.equal(userResult.rowCount, 1);

  const user = userResult.rows[0];

  assert.equal(user.email_normalized, successfulEmail);
  assert.equal(user.display_name, "Registration Integration User");
  assert.equal(user.email_verified_at, null);
  assert.equal(user.status, "ACTIVE");
  assert.notEqual(user.password_hash, password);
  assert.equal(await passwords.verifyPassword(password, user.password_hash), true);

  const tokenResult = await migrator.query(
    `SELECT token_hash, expires_at, consumed_at
     FROM email_verification_tokens
     WHERE user_id = $1`,
    [user.id],
  );

  assert.equal(tokenResult.rowCount, 1);
  assert.equal(tokenResult.rows[0].token_hash, hashToken(rawToken));
  assert.notEqual(tokenResult.rows[0].token_hash, rawToken);
  assert.equal(tokenResult.rows[0].consumed_at, null);

  const remainingLifetime = new Date(tokenResult.rows[0].expires_at).getTime() - Date.now();

  assert.ok(
    remainingLifetime > 0 && remainingLifetime <= 30 * 60 * 1000,
    "Verification token must expire within 30 minutes",
  );
});

test("Duplicate registration returns the same generic response without creating another account", async () => {
  const response = await auth.register({
    email: duplicateEmail,
    password: "duplicate-registration-password",
  });

  assert.deepEqual(response, registrationResponse);

  const firstTokenCount = await migrator.query(
    `SELECT count(*)::int AS total
     FROM email_verification_tokens
     WHERE user_id IN (
       SELECT id FROM users WHERE email_normalized = $1
     )`,
    [duplicateEmail],
  );

  assert.equal(firstTokenCount.rows[0].total, 1);

  const attemptsBeforeDuplicate = deliveryAttempts.length;

  const duplicateResponse = await auth.register({
    email: duplicateEmail.toUpperCase(),
    password: "another-registration-password",
  });

  assert.deepEqual(duplicateResponse, registrationResponse);
  assert.equal(deliveryAttempts.length, attemptsBeforeDuplicate);

  const userCount = await migrator.query(
    "SELECT count(*)::int AS total FROM users WHERE email_normalized = $1",
    [duplicateEmail],
  );

  assert.equal(userCount.rows[0].total, 1);
});

test("Email-delivery failure preserves the unverified account and hashed token", async () => {
  deliveryFailure = true;

  try {
    await assert.rejects(
      auth.register({
        email: failedDeliveryEmail,
        password: "delivery-failure-password",
      }),
      (error) => error?.getStatus?.() === 500,
    );
  } finally {
    deliveryFailure = false;
  }

  const userResult = await migrator.query(
    `SELECT id, email_verified_at
     FROM users
     WHERE email_normalized = $1`,
    [failedDeliveryEmail],
  );

  assert.equal(userResult.rowCount, 1);
  assert.equal(userResult.rows[0].email_verified_at, null);

  const tokenResult = await migrator.query(
    `SELECT token_hash, expires_at, consumed_at
     FROM email_verification_tokens
     WHERE user_id = $1`,
    [userResult.rows[0].id],
  );

  assert.equal(tokenResult.rowCount, 1);
  assert.match(tokenResult.rows[0].token_hash, /^[a-f0-9]{64}$/);
  assert.equal(tokenResult.rows[0].consumed_at, null);
  assert.ok(new Date(tokenResult.rows[0].expires_at).getTime() > Date.now());
});

test("Valid verification token verifies the email and cannot be reused", async () => {
  assert.ok(successfulVerificationToken);

  const response = await auth.verifyEmail(successfulVerificationToken);

  assert.deepEqual(response, {
    message: "If the verification link is valid, the email address has been verified.",
  });

  const userResult = await migrator.query(
    "SELECT email_verified_at FROM users WHERE email_normalized = $1",
    [successfulEmail],
  );

  assert.equal(userResult.rowCount, 1);
  assert.ok(userResult.rows[0].email_verified_at);

  const tokenResult = await migrator.query(
    `SELECT consumed_at
     FROM email_verification_tokens
     WHERE token_hash = $1`,
    [hashToken(successfulVerificationToken)],
  );

  assert.equal(tokenResult.rowCount, 1);
  assert.ok(tokenResult.rows[0].consumed_at);

  const secondResponse = await auth.verifyEmail(successfulVerificationToken);

  assert.deepEqual(secondResponse, response);
});

test("Malformed verification tokens return the generic response without database changes", async () => {
  const response = await auth.verifyEmail("not-a-valid-verification-token");

  assert.deepEqual(response, {
    message: "If the verification link is valid, the email address has been verified.",
  });

  const userResult = await migrator.query(
    "SELECT email_verified_at FROM users WHERE email_normalized = $1",
    [successfulEmail],
  );

  assert.ok(userResult.rows[0].email_verified_at);
});

test("Expired verification tokens cannot verify an email", async () => {
  await auth.register({
    email: expiredVerificationEmail,
    password: "expired-verification-password",
  });

  const delivery = deliveryAttempts.findLast(
    (attempt) => attempt.email === expiredVerificationEmail,
  );

  assert.ok(delivery);

  const expiredToken = new URL(delivery.verificationUrl).searchParams.get("token");

  await migrator.query(
    `UPDATE email_verification_tokens
     SET created_at = NOW() - INTERVAL '2 minutes',
         expires_at = NOW() - INTERVAL '1 minute'
     WHERE token_hash = $1`,
    [hashToken(expiredToken)],
  );

  const response = await auth.verifyEmail(expiredToken);

  assert.deepEqual(response, {
    message: "If the verification link is valid, the email address has been verified.",
  });

  const userResult = await migrator.query(
    "SELECT email_verified_at FROM users WHERE email_normalized = $1",
    [expiredVerificationEmail],
  );

  assert.equal(userResult.rowCount, 1);
  assert.equal(userResult.rows[0].email_verified_at, null);
});

test("Concurrent verification requests cannot consume the same token twice", async () => {
  await auth.register({
    email: concurrentVerificationEmail,
    password: "concurrent-verification-password",
  });

  const delivery = deliveryAttempts.findLast(
    (attempt) => attempt.email === concurrentVerificationEmail,
  );

  assert.ok(delivery);

  const token = new URL(delivery.verificationUrl).searchParams.get("token");

  const responses = await Promise.all([auth.verifyEmail(token), auth.verifyEmail(token)]);

  assert.deepEqual(responses[0], responses[1]);

  const result = await migrator.query(
    `SELECT u.email_verified_at, t.consumed_at
     FROM users u
     JOIN email_verification_tokens t ON t.user_id = u.id
     WHERE u.email_normalized = $1`,
    [concurrentVerificationEmail],
  );

  assert.equal(result.rowCount, 1);
  assert.ok(result.rows[0].email_verified_at);
  assert.ok(result.rows[0].consumed_at);
});

test("Verification preserves an existing email verification timestamp", async () => {
  await auth.register({
    email: alreadyVerifiedEmail,
    password: "already-verified-password",
  });

  const delivery = deliveryAttempts.findLast((attempt) => attempt.email === alreadyVerifiedEmail);

  assert.ok(delivery);

  const token = new URL(delivery.verificationUrl).searchParams.get("token");

  const originalTimestamp = new Date("2025-01-01T12:00:00.000Z");

  await migrator.query(
    `UPDATE users
     SET email_verified_at = $1
     WHERE email_normalized = $2`,
    [originalTimestamp, alreadyVerifiedEmail],
  );

  const response = await auth.verifyEmail(token);

  assert.deepEqual(response, {
    message: "If the verification link is valid, the email address has been verified.",
  });

  const result = await migrator.query(
    `SELECT u.email_verified_at, t.consumed_at
     FROM users u
     JOIN email_verification_tokens t ON t.user_id = u.id
     WHERE u.email_normalized = $1`,
    [alreadyVerifiedEmail],
  );

  assert.equal(result.rowCount, 1);
  assert.equal(
    new Date(result.rows[0].email_verified_at).toISOString(),
    originalTimestamp.toISOString(),
  );
  assert.ok(result.rows[0].consumed_at);
});

test("Resending verification for an unknown email returns the generic response", async () => {
  const unknownEmail = `${randomUUID()}@example.invalid`;
  const attemptsBefore = deliveryAttempts.length;

  const response = await auth.resendVerification(unknownEmail);

  assert.deepEqual(response, registrationResponse);
  assert.equal(deliveryAttempts.length, attemptsBefore);

  const result = await migrator.query("SELECT id FROM users WHERE email_normalized = $1", [
    unknownEmail,
  ]);
  assert.equal(result.rowCount, 0);
});

test("Resending verification for an already-verified account changes nothing", async () => {
  const attemptsBefore = deliveryAttempts.filter(
    (attempt) => attempt.email === alreadyVerifiedEmail,
  ).length;

  const tokensBefore = await migrator.query(
    `SELECT token_hash, consumed_at
     FROM email_verification_tokens
     WHERE user_id = (
       SELECT id FROM users WHERE email_normalized = $1
     )`,
    [alreadyVerifiedEmail],
  );

  const response = await auth.resendVerification(alreadyVerifiedEmail);
  assert.deepEqual(response, registrationResponse);

  const attemptsAfter = deliveryAttempts.filter(
    (attempt) => attempt.email === alreadyVerifiedEmail,
  ).length;
  assert.equal(attemptsAfter, attemptsBefore);

  const tokensAfter = await migrator.query(
    `SELECT token_hash, consumed_at
     FROM email_verification_tokens
     WHERE user_id = (
       SELECT id FROM users WHERE email_normalized = $1
     )`,
    [alreadyVerifiedEmail],
  );

  assert.deepEqual(tokensAfter.rows, tokensBefore.rows);
});

test("Resending verification replaces the old token and the new token verifies the account", async () => {
  await auth.register({
    email: resendVerificationEmail,
    password: "resend-verification-password",
  });

  const originalDelivery = deliveryAttempts.findLast(
    (attempt) => attempt.email === resendVerificationEmail,
  );
  assert.ok(originalDelivery);

  const originalToken = new URL(originalDelivery.verificationUrl).searchParams.get("token");
  assert.ok(originalToken);

  const response = await auth.resendVerification(resendVerificationEmail);
  assert.deepEqual(response, registrationResponse);

  const replacementDelivery = deliveryAttempts.findLast(
    (attempt) => attempt.email === resendVerificationEmail,
  );
  assert.ok(replacementDelivery);

  const replacementToken = new URL(replacementDelivery.verificationUrl).searchParams.get("token");
  assert.ok(replacementToken);
  assert.notEqual(replacementToken, originalToken);

  const tokenResult = await migrator.query(
    `SELECT token_hash, consumed_at
     FROM email_verification_tokens
     WHERE user_id = (
       SELECT id FROM users WHERE email_normalized = $1
     )
     ORDER BY created_at`,
    [resendVerificationEmail],
  );

  assert.equal(tokenResult.rowCount, 2);
  assert.ok(tokenResult.rows[0].consumed_at);
  assert.equal(tokenResult.rows[1].token_hash, hashToken(replacementToken));
  assert.equal(tokenResult.rows[1].consumed_at, null);

  await auth.verifyEmail(originalToken);

  const beforeReplacementVerification = await migrator.query(
    "SELECT email_verified_at FROM users WHERE email_normalized = $1",
    [resendVerificationEmail],
  );
  assert.equal(beforeReplacementVerification.rows[0].email_verified_at, null);

  await auth.verifyEmail(replacementToken);

  const afterReplacementVerification = await migrator.query(
    "SELECT email_verified_at FROM users WHERE email_normalized = $1",
    [resendVerificationEmail],
  );
  assert.ok(afterReplacementVerification.rows[0].email_verified_at);
});

test("Resend delivery failure leaves one replacement token available for retry", async () => {
  await auth.register({
    email: resendDeliveryFailureEmail,
    password: "resend-delivery-failure-password",
  });

  const originalDelivery = deliveryAttempts.findLast(
    (attempt) => attempt.email === resendDeliveryFailureEmail,
  );
  assert.ok(originalDelivery);

  const originalToken = new URL(originalDelivery.verificationUrl).searchParams.get("token");
  assert.ok(originalToken);

  deliveryFailure = true;
  try {
    await assert.rejects(auth.resendVerification(resendDeliveryFailureEmail));
  } finally {
    deliveryFailure = false;
  }

  const failedDelivery = deliveryAttempts.findLast(
    (attempt) => attempt.email === resendDeliveryFailureEmail,
  );
  assert.ok(failedDelivery);

  const replacementToken = new URL(failedDelivery.verificationUrl).searchParams.get("token");
  assert.ok(replacementToken);
  assert.notEqual(replacementToken, originalToken);

  const tokenResult = await migrator.query(
    `SELECT token_hash, consumed_at
     FROM email_verification_tokens
     WHERE user_id = (
       SELECT id FROM users WHERE email_normalized = $1
     )
     ORDER BY created_at`,
    [resendDeliveryFailureEmail],
  );

  assert.equal(tokenResult.rowCount, 2);
  assert.ok(tokenResult.rows[0].consumed_at);
  assert.equal(tokenResult.rows[1].token_hash, hashToken(replacementToken));
  assert.equal(tokenResult.rows[1].consumed_at, null);

  const retryResponse = await auth.resendVerification(resendDeliveryFailureEmail);
  assert.deepEqual(retryResponse, registrationResponse);

  const successfulRetry = deliveryAttempts.findLast(
    (attempt) => attempt.email === resendDeliveryFailureEmail,
  );
  assert.ok(successfulRetry);

  const successfulRetryToken = new URL(successfulRetry.verificationUrl).searchParams.get("token");
  assert.ok(successfulRetryToken);
  assert.notEqual(successfulRetryToken, replacementToken);

  const retryTokenResult = await migrator.query(
    `SELECT token_hash, consumed_at
     FROM email_verification_tokens
     WHERE user_id = (
       SELECT id FROM users WHERE email_normalized = $1
     )
     ORDER BY created_at`,
    [resendDeliveryFailureEmail],
  );

  assert.equal(retryTokenResult.rowCount, 3);
  assert.ok(retryTokenResult.rows[0].consumed_at);
  assert.ok(retryTokenResult.rows[1].consumed_at);
  assert.equal(retryTokenResult.rows[2].token_hash, hashToken(successfulRetryToken));
  assert.equal(retryTokenResult.rows[2].consumed_at, null);

  await auth.verifyEmail(successfulRetryToken);

  const verifiedUser = await migrator.query(
    "SELECT email_verified_at FROM users WHERE email_normalized = $1",
    [resendDeliveryFailureEmail],
  );
  assert.ok(verifiedUser.rows[0].email_verified_at);
});

test("Concurrent resends leave exactly one unconsumed verification token", async () => {
  await auth.register({
    email: concurrentResendEmail,
    password: "concurrent-resend-password",
  });

  const initialAttemptCount = deliveryAttempts.filter(
    (attempt) => attempt.email === concurrentResendEmail,
  ).length;

  const responses = await Promise.all([
    auth.resendVerification(concurrentResendEmail),
    auth.resendVerification(concurrentResendEmail),
  ]);

  assert.deepEqual(responses[0], registrationResponse);
  assert.deepEqual(responses[1], registrationResponse);

  const resendAttempts = deliveryAttempts
    .filter((attempt) => attempt.email === concurrentResendEmail)
    .slice(initialAttemptCount);

  assert.equal(resendAttempts.length, 2);

  const tokenResult = await migrator.query(
    `SELECT token_hash, consumed_at
     FROM email_verification_tokens
     WHERE user_id = (
       SELECT id FROM users WHERE email_normalized = $1
     )`,
    [concurrentResendEmail],
  );

  assert.equal(tokenResult.rowCount, 3);

  const activeTokens = tokenResult.rows.filter((token) => token.consumed_at === null);
  assert.equal(activeTokens.length, 1);

  const deliveredTokens = resendAttempts.map((attempt) =>
    new URL(attempt.verificationUrl).searchParams.get("token"),
  );

  assert.equal(
    deliveredTokens.filter((token) => hashToken(token) === activeTokens[0].token_hash.trim())
      .length,
    1,
  );
});

test("Concurrent verification and resend preserve a consistent account state", async () => {
  await auth.register({
    email: verificationResendRaceEmail,
    password: "verification-resend-race-password",
  });

  const initialDelivery = deliveryAttempts.findLast(
    (attempt) => attempt.email === verificationResendRaceEmail,
  );
  assert.ok(initialDelivery);

  const originalToken = new URL(initialDelivery.verificationUrl).searchParams.get("token");
  assert.ok(originalToken);

  const attemptsBeforeRace = deliveryAttempts.filter(
    (attempt) => attempt.email === verificationResendRaceEmail,
  ).length;

  const [verificationResponse, resendResponse] = await Promise.all([
    auth.verifyEmail(originalToken),
    auth.resendVerification(verificationResendRaceEmail),
  ]);

  assert.deepEqual(verificationResponse, {
    message: "If the verification link is valid, the email address has been verified.",
  });
  assert.deepEqual(resendResponse, registrationResponse);

  const userResult = await migrator.query(
    `SELECT email_verified_at
     FROM users
     WHERE email_normalized = $1`,
    [verificationResendRaceEmail],
  );
  assert.equal(userResult.rowCount, 1);

  const tokenResult = await migrator.query(
    `SELECT token_hash, consumed_at
     FROM email_verification_tokens
     WHERE user_id = (
       SELECT id FROM users WHERE email_normalized = $1
     )`,
    [verificationResendRaceEmail],
  );

  const activeTokens = tokenResult.rows.filter((token) => token.consumed_at === null);
  const resendAttempts = deliveryAttempts
    .filter((attempt) => attempt.email === verificationResendRaceEmail)
    .slice(attemptsBeforeRace);

  if (userResult.rows[0].email_verified_at !== null) {
    assert.equal(tokenResult.rowCount, 1);
    assert.equal(activeTokens.length, 0);
    assert.equal(resendAttempts.length, 0);
  } else {
    assert.equal(tokenResult.rowCount, 2);
    assert.equal(activeTokens.length, 1);
    assert.equal(resendAttempts.length, 1);

    const replacementToken = new URL(resendAttempts[0].verificationUrl).searchParams.get("token");
    assert.ok(replacementToken);
    assert.equal(activeTokens[0].token_hash.trim(), hashToken(replacementToken));
  }
});

test("HTTP CORS allows only the configured frontend origin with credentials", async () => {
  const allowedOrigin = new URL(process.env.WEB_APP_URL).origin;

  const allowedResponse = await fetch(`${apiBaseUrl}/api/v1/auth/register`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-csrf-token",
    },
  });

  assert.equal(allowedResponse.status, 204);
  assert.equal(allowedResponse.headers.get("access-control-allow-origin"), allowedOrigin);
  assert.equal(allowedResponse.headers.get("access-control-allow-credentials"), "true");
  assert.notEqual(allowedResponse.headers.get("access-control-allow-origin"), "*");

  const rejectedResponse = await fetch(`${apiBaseUrl}/api/v1/auth/register`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://untrusted.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  assert.equal(rejectedResponse.headers.get("access-control-allow-origin"), null);
  assert.notEqual(rejectedResponse.headers.get("access-control-allow-origin"), "*");
});

test("HTTP registration and email verification routes enforce validation and complete the flow", async () => {
  const registrationResponseFromApi = await fetch(`${apiBaseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `  ${httpRegistrationEmail.toUpperCase()}  `,
      password: "http-registration-password",
      displayName: "HTTP Integration User",
    }),
  });

  assert.equal(registrationResponseFromApi.status, 201);
  assert.deepEqual(await registrationResponseFromApi.json(), registrationResponse);

  const delivery = deliveryAttempts.findLast((attempt) => attempt.email === httpRegistrationEmail);
  assert.ok(delivery);

  const token = new URL(delivery.verificationUrl).searchParams.get("token");
  assert.ok(token);

  const verificationResponse = await fetch(`${apiBaseUrl}/api/v1/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  assert.equal(verificationResponse.status, 201);
  assert.deepEqual(await verificationResponse.json(), {
    message: "If the verification link is valid, the email address has been verified.",
  });

  const userResult = await migrator.query(
    `SELECT email_verified_at
     FROM users
     WHERE email_normalized = $1`,
    [httpRegistrationEmail],
  );

  assert.equal(userResult.rowCount, 1);
  assert.ok(userResult.rows[0].email_verified_at);

  const malformedTokenResponse = await fetch(`${apiBaseUrl}/api/v1/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "invalid" }),
  });

  assert.equal(malformedTokenResponse.status, 400);

  const unexpectedFieldResponse = await fetch(`${apiBaseUrl}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `${randomUUID()}@example.invalid`,
      password: "http-registration-password",
      unexpected: "must be rejected",
    }),
  });

  assert.equal(unexpectedFieldResponse.status, 400);
});

test("HTTP authentication routes enforce IP and identity rate limits", async () => {
  const cases = [
    {
      operation: "register",
      dimension: "ip",
      path: "/api/v1/auth/register",
      body: {
        email: `${randomUUID()}@example.invalid`,
        password: "http-registration-password",
      },
      limit: 10,
      windowSeconds: 15 * 60,
    },
    {
      operation: "register",
      dimension: "email",
      path: "/api/v1/auth/register",
      body: {
        email: `${randomUUID()}@example.invalid`,
        password: "http-registration-password",
      },
      limit: 5,
      windowSeconds: 60 * 60,
    },
    {
      operation: "verify-email",
      dimension: "ip",
      path: "/api/v1/auth/verify-email",
      body: { token: "A".repeat(43) },
      limit: 30,
      windowSeconds: 15 * 60,
    },
    {
      operation: "verify-email",
      dimension: "token",
      path: "/api/v1/auth/verify-email",
      body: { token: "A".repeat(43) },
      limit: 5,
      windowSeconds: 15 * 60,
    },
    {
      operation: "resend-verification",
      dimension: "ip",
      path: "/api/v1/auth/resend-verification",
      body: { email: `${randomUUID()}@example.invalid` },
      limit: 10,
      windowSeconds: 60 * 60,
    },
    {
      operation: "resend-verification",
      dimension: "email",
      path: "/api/v1/auth/resend-verification",
      body: { email: `${randomUUID()}@example.invalid` },
      limit: 3,
      windowSeconds: 60 * 60,
    },
  ];

  const deliveryCountBefore = deliveryAttempts.length;

  try {
    for (const scenario of cases) {
      rateLimitCalls.length = 0;
      blockedRateLimit = {
        operation: scenario.operation,
        dimension: scenario.dimension,
      };

      const response = await fetch(`${apiBaseUrl}${scenario.path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(scenario.body),
      });

      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "42");

      const calls = rateLimitCalls;

      assert.equal(
        calls.length,
        scenario.dimension === "ip" ? 1 : 2,
        `${scenario.operation}/${scenario.dimension} should stop at the rejected limit`,
      );

      const rejectedCall = calls.at(-1);

      assert.equal(rejectedCall.operation, scenario.operation);
      assert.equal(rejectedCall.dimension, scenario.dimension);
      assert.equal(rejectedCall.limit, scenario.limit);
      assert.equal(rejectedCall.windowSeconds, scenario.windowSeconds);

      if (scenario.dimension !== "ip") {
        const expectedIdentifier =
          scenario.operation === "verify-email" ? scenario.body.token : scenario.body.email;

        assert.equal(rejectedCall.identifier, expectedIdentifier);
      }
    }

    assert.equal(
      deliveryAttempts.length,
      deliveryCountBefore,
      "Rate-limited requests must not trigger email delivery",
    );
  } finally {
    blockedRateLimit = null;
    rateLimitCalls.length = 0;
  }
});

test("Password reset is generic, single-use, expires, revokes sessions, and replaces the password", async () => {
  const oldPassword = "password-reset-old-password";
  const newPassword = "password-reset-new-password";
  await auth.register({ email: passwordResetEmail, password: oldPassword });
  const verificationDelivery = deliveryAttempts.findLast(
    (item) => item.email === passwordResetEmail,
  );
  assert.ok(verificationDelivery);
  await auth.verifyEmail(new URL(verificationDelivery.verificationUrl).searchParams.get("token"));

  const unknown = await auth.requestPasswordReset(`${randomUUID()}@example.invalid`);
  assert.deepEqual(unknown, await auth.requestPasswordReset(passwordResetEmail));
  const resetDelivery = passwordResetDeliveryAttempts.findLast(
    (item) => item.email === passwordResetEmail,
  );
  assert.ok(resetDelivery);
  const resetToken = new URL(resetDelivery.resetUrl).searchParams.get("token");
  assert.match(resetToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(resetDelivery.resetUrl).pathname, "/reset-password");

  const row = await migrator.query(
    `SELECT id, token_hash, expires_at, consumed_at FROM password_reset_tokens
     WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)`,
    [passwordResetEmail],
  );
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].token_hash, hashToken(resetToken));
  assert.equal(row.rows[0].consumed_at, null);
  assert.ok(new Date(row.rows[0].expires_at).getTime() - Date.now() <= 30 * 60 * 1000);

  const loggedIn = await auth.login({ email: passwordResetEmail, password: oldPassword });
  assert.equal(loggedIn.kind, "SESSION");
  await auth.confirmPasswordReset(resetToken, newPassword);
  assert.deepEqual(await auth.confirmPasswordReset(resetToken, "another-password-reset-pass"), {
    message:
      "If the password reset link is valid, the password has been reset. Sign in with your new password.",
  });
  await assert.rejects(auth.login({ email: passwordResetEmail, password: oldPassword }));
  assert.equal(
    (await auth.login({ email: passwordResetEmail, password: newPassword })).kind,
    "SESSION",
  );

  const session = await migrator.query(
    "SELECT revoked_at FROM auth_sessions WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1) ORDER BY created_at",
    [passwordResetEmail],
  );
  assert.ok(session.rows.length >= 1);
  assert.equal(session.rows.length, 2);
  assert.ok(session.rows[0].revoked_at, "password reset revokes sessions that predate it");
  assert.equal(session.rows[1].revoked_at, null, "a later login creates a fresh session");

  await auth.requestPasswordReset(passwordResetEmail);
  const expiredDelivery = passwordResetDeliveryAttempts.findLast(
    (item) => item.email === passwordResetEmail,
  );
  const expiredToken = new URL(expiredDelivery.resetUrl).searchParams.get("token");
  await migrator.query(
    `UPDATE password_reset_tokens
     SET created_at = now() - interval '2 seconds', expires_at = now() - interval '1 second'
     WHERE token_hash = $1`,
    [hashToken(expiredToken)],
  );
  assert.deepEqual(await auth.confirmPasswordReset(expiredToken, "expired-reset-password-value"), {
    message:
      "If the password reset link is valid, the password has been reset. Sign in with your new password.",
  });
  await assert.rejects(
    auth.login({ email: passwordResetEmail, password: "expired-reset-password-value" }),
  );

  deliveryFailure = true;
  try {
    assert.deepEqual(await auth.requestPasswordReset(passwordResetEmail), {
      message:
        "If the account is eligible, password reset instructions will be sent to the provided email address.",
    });
  } finally {
    deliveryFailure = false;
  }
});

test("HTTP password-reset endpoints require the frontend origin and apply rate limits", async () => {
  const endpoint = `${apiBaseUrl}/api/v1/auth/password-reset/request`;
  const body = { email: `${randomUUID()}@example.invalid` };
  const rejectedOrigin = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.invalid" },
    body: JSON.stringify(body),
  });
  assert.equal(rejectedOrigin.status, 403);

  rateLimitCalls.length = 0;
  blockedRateLimit = { operation: "password-reset-request", dimension: "email" };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(process.env.WEB_APP_URL).origin,
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "42");
    assert.deepEqual(
      rateLimitCalls.map(({ operation, dimension }) => ({ operation, dimension })),
      [
        { operation: "password-reset-request", dimension: "ip" },
        { operation: "password-reset-request", dimension: "email" },
      ],
    );
  } finally {
    blockedRateLimit = null;
    rateLimitCalls.length = 0;
  }

  const confirmationEndpoint = `${apiBaseUrl}/api/v1/auth/password-reset/confirm`;
  for (const dimension of ["ip", "token"]) {
    rateLimitCalls.length = 0;
    blockedRateLimit = { operation: "password-reset-confirm", dimension };
    try {
      const response = await fetch(confirmationEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: new URL(process.env.WEB_APP_URL).origin,
        },
        body: JSON.stringify({ token: "A".repeat(43), newPassword: "new-password-valid" }),
      });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "42");
      assert.deepEqual(
        rateLimitCalls.map(({ operation, dimension: checkedDimension }) => ({
          operation,
          dimension: checkedDimension,
        })),
        dimension === "ip"
          ? [{ operation: "password-reset-confirm", dimension: "ip" }]
          : [
              { operation: "password-reset-confirm", dimension: "ip" },
              { operation: "password-reset-confirm", dimension: "token" },
            ],
      );
      if (dimension === "token") {
        assert.equal(rateLimitCalls.at(-1).identifier, hashToken("A".repeat(43)));
      }
    } finally {
      blockedRateLimit = null;
      rateLimitCalls.length = 0;
    }
  }
});

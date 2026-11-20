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
import { RateLimitService } from "../dist/rate-limit/rate-limit.service.js";
import { SessionService } from "../dist/identity/session.service.js";

const frontendOrigin = new URL(process.env.WEB_APP_URL).origin;
const validPassword = "integration-login-password";

const users = {
  login: `${randomUUID()}@example.invalid`,
  unverified: `${randomUUID()}@example.invalid`,
  inactive: `${randomUUID()}@example.invalid`,
  logoutAll: `${randomUUID()}@example.invalid`,
};

const fixtureEmails = Object.values(users);

let app;
let migrator;
let passwords;
let sessions;
let apiBaseUrl;
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

const sessionCookieName = "__Host-serviceflow_session";

function getCookie(response) {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "Expected a Set-Cookie response header");

  const match = setCookie.match(new RegExp(`${sessionCookieName}=([^;]+)`));
  assert.ok(match, "Expected the session cookie");
  return match[1];
}

function cookieHeader(token) {
  return `${sessionCookieName}=${token}`;
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function createUser(email, options = {}) {
  const id = randomUUID();
  const passwordHash = await passwords.hashPassword(validPassword);
  const emailVerifiedAt = options.verified === false ? null : new Date();
  const status = options.status ?? "ACTIVE";

  const result = await migrator.query(
    `INSERT INTO users (
       id,
       email_normalized,
       password_hash,
       email_verified_at,
       status,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
     RETURNING id`,
    [id, email, passwordHash, emailVerifiedAt, status],
  );

  return result.rows[0].id;
}

async function login(email, password = validPassword, extraHeaders = {}) {
  return fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: frontendOrigin,
      ...extraHeaders,
    },
    body: JSON.stringify({ email, password }),
  });
}

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.MIGRATION_DATABASE_URL);
  assert.ok(process.env.WEB_APP_URL);
  assert.ok(process.env.CSRF_HMAC_SECRET);

  migrator = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await migrator.connect();

  const identity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(identity.rows[0].role, "serviceflow_migrator");
  assert.equal(identity.rows[0].database, "serviceflow_dev");

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(RateLimitService)
    .useValue(rateLimitProvider)
    .compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");

  app.enableCors({
    origin: (requestOrigin, callback) => callback(null, requestOrigin === frontendOrigin),
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
  passwords = app.get(PasswordService);
  sessions = app.get(SessionService);

  const prisma = app.get(PrismaService);
  const appIdentity = await prisma.$queryRaw`
    SELECT current_user AS role, current_database() AS database
  `;

  assert.equal(appIdentity[0].role, "serviceflow_app");
  assert.equal(appIdentity[0].database, "serviceflow_dev");

  await createUser(users.login);
  await createUser(users.unverified, { verified: false });
  await createUser(users.inactive, { status: "SUSPENDED" });
  await createUser(users.logoutAll);
});

after(async () => {
  try {
    if (migrator) {
      await migrator.query("DELETE FROM users WHERE email_normalized = ANY($1::text[])", [
        fixtureEmails,
      ]);
    }
  } finally {
    if (app) await app.close();
    if (migrator) await migrator.end();
  }
});

test("Login requires the exact configured frontend origin", async () => {
  const missingOrigin = await fetch(`${apiBaseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: users.login, password: validPassword }),
  });

  assert.equal(missingOrigin.status, 403);

  const foreignOrigin = await login(users.login, validPassword, {
    Origin: "https://untrusted.example",
  });

  assert.equal(foreignOrigin.status, 403);

  const sessionsResult = await migrator.query(
    `SELECT count(*)::int AS total
     FROM auth_sessions
     WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)`,
    [users.login],
  );

  assert.equal(sessionsResult.rows[0].total, 0);
});

test("Successful login issues an opaque secure cookie and a session-bound CSRF token", async () => {
  const response = await login(` ${users.login.toUpperCase()} `);

  assert.equal(response.status, 200);

  const body = await response.json();
  assert.match(body.csrfToken, /^[a-f0-9]{64}$/);
  assert.ok(body.expiresAt);
  assert.equal(Object.hasOwn(body, "token"), false);

  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  assert.match(cookie, /^__Host-serviceflow_session=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.doesNotMatch(cookie, /Domain=/i);

  const token = getCookie(response);
  const stored = await migrator.query(
    `SELECT session_hash, expires_at, user_agent
     FROM auth_sessions
     WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)`,
    [users.login],
  );

  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].session_hash, hashToken(token));
  assert.notEqual(stored.rows[0].session_hash, token);

  const csrfResponse = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: { Cookie: cookieHeader(token) },
  });

  assert.equal(csrfResponse.status, 200);
  assert.equal(csrfResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await csrfResponse.json(), { csrfToken: body.csrfToken });
});

test("Invalid, unverified, and inactive accounts receive the same generic login rejection", async () => {
  const invalidPassword = await login(users.login, "incorrect-password");
  const unverified = await login(users.unverified);
  const inactive = await login(users.inactive);
  const unknown = await login(`${randomUUID()}@example.invalid`);

  for (const response of [invalidPassword, unverified, inactive, unknown]) {
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      message: "Invalid email or password.",
      error: "Unauthorized",
      statusCode: 401,
    });
    assert.equal(response.headers.get("set-cookie"), null);
  }
});

test("CSRF endpoint and logout reject missing, malformed, and cross-session credentials", async () => {
  const firstLogin = await login(users.login);
  const firstToken = getCookie(firstLogin);
  const firstBody = await firstLogin.json();

  const secondLogin = await login(users.login);
  const secondToken = getCookie(secondLogin);

  const noCookie = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`);
  assert.equal(noCookie.status, 401);

  const missingCsrf = await fetch(`${apiBaseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: {
      Origin: frontendOrigin,
      Cookie: cookieHeader(firstToken),
    },
  });
  assert.equal(missingCsrf.status, 403);

  const malformedCsrf = await fetch(`${apiBaseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: {
      Origin: frontendOrigin,
      Cookie: cookieHeader(firstToken),
      "X-CSRF-Token": "invalid",
    },
  });
  assert.equal(malformedCsrf.status, 403);

  const crossSessionCsrf = await fetch(`${apiBaseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: {
      Origin: frontendOrigin,
      Cookie: cookieHeader(secondToken),
      "X-CSRF-Token": firstBody.csrfToken,
    },
  });
  assert.equal(crossSessionCsrf.status, 403);

  assert.ok(await sessions.validateSession(firstToken));
  assert.ok(await sessions.validateSession(secondToken));
});

test("Logout requires the exact origin and CSRF proof, then revokes the session", async () => {
  const response = await login(users.login);
  const token = getCookie(response);
  const body = await response.json();

  const rejectedOrigin = await fetch(`${apiBaseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: {
      Origin: "https://untrusted.example",
      Cookie: cookieHeader(token),
      "X-CSRF-Token": body.csrfToken,
    },
  });

  assert.equal(rejectedOrigin.status, 403);
  assert.ok(await sessions.validateSession(token));

  const logoutResponse = await fetch(`${apiBaseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: {
      Origin: frontendOrigin,
      Cookie: cookieHeader(token),
      "X-CSRF-Token": body.csrfToken,
    },
  });

  assert.equal(logoutResponse.status, 200);
  assert.deepEqual(await logoutResponse.json(), { message: "Logged out." });

  const clearedCookie = logoutResponse.headers.get("set-cookie");
  assert.ok(clearedCookie);
  assert.match(clearedCookie, /^__Host-serviceflow_session=;/);
  assert.match(clearedCookie, /Max-Age=0/);
  assert.match(clearedCookie, /HttpOnly/i);
  assert.match(clearedCookie, /Secure/i);

  assert.equal(await sessions.validateSession(token), null);

  const reuse = await fetch(`${apiBaseUrl}/api/v1/auth/csrf`, {
    headers: { Cookie: cookieHeader(token) },
  });
  assert.equal(reuse.status, 401);
});

test("Logout-all revokes every active session belonging to the authenticated user", async () => {
  const firstLogin = await login(users.logoutAll);
  const firstToken = getCookie(firstLogin);
  const firstBody = await firstLogin.json();

  const secondLogin = await login(users.logoutAll);
  const secondToken = getCookie(secondLogin);

  const response = await fetch(`${apiBaseUrl}/api/v1/auth/logout-all`, {
    method: "POST",
    headers: {
      Origin: frontendOrigin,
      Cookie: cookieHeader(firstToken),
      "X-CSRF-Token": firstBody.csrfToken,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: "All sessions have been logged out.",
  });

  assert.ok(response.headers.get("set-cookie"));
  assert.equal(await sessions.validateSession(firstToken), null);
  assert.equal(await sessions.validateSession(secondToken), null);

  const records = await migrator.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked
     FROM auth_sessions
     WHERE user_id = (SELECT id FROM users WHERE email_normalized = $1)`,
    [users.logoutAll],
  );

  assert.equal(records.rows[0].total, 2);
  assert.equal(records.rows[0].revoked, 2);
});

test("Login enforces IP and email rate limits in order", async () => {
  const scenarios = [
    { dimension: "ip", expectedCalls: 1, limit: 20 },
    { dimension: "email", expectedCalls: 2, limit: 5 },
  ];

  try {
    for (const scenario of scenarios) {
      rateLimitCalls.length = 0;
      blockedRateLimit = {
        operation: "login",
        dimension: scenario.dimension,
      };

      const response = await login(users.login);

      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "42");
      assert.equal(rateLimitCalls.length, scenario.expectedCalls);

      const rejectedCall = rateLimitCalls.at(-1);
      assert.equal(rejectedCall.operation, "login");
      assert.equal(rejectedCall.dimension, scenario.dimension);
      assert.equal(rejectedCall.limit, scenario.limit);
      assert.equal(rejectedCall.windowSeconds, 15 * 60);
    }
  } finally {
    blockedRateLimit = null;
    rateLimitCalls.length = 0;
  }
});

test("Current-user endpoint requires an active session and returns only safe profile fields", async () => {
  const unauthenticated = await fetch(`${apiBaseUrl}/api/v1/auth/me`);

  assert.equal(unauthenticated.status, 401);

  const loginResponse = await login(users.login);
  const token = getCookie(loginResponse);

  const response = await fetch(`${apiBaseUrl}/api/v1/auth/me`, {
    headers: {
      Cookie: cookieHeader(token),
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const profile = await response.json();

  assert.deepEqual(Object.keys(profile).sort(), ["displayName", "email", "emailVerifiedAt", "id"]);

  assert.equal(profile.email, users.login);
  assert.equal(profile.displayName, null);
  assert.ok(profile.id);
  assert.equal(
    profile.id,
    (await migrator.query("SELECT id FROM users WHERE email_normalized = $1", [users.login]))
      .rows[0].id,
  );
  assert.ok(profile.emailVerifiedAt);

  assert.equal(await sessions.revokeSession(token), true);

  const revokedSessionResponse = await fetch(`${apiBaseUrl}/api/v1/auth/me`, {
    headers: {
      Cookie: cookieHeader(token),
    },
  });

  assert.equal(revokedSessionResponse.status, 401);
});

test("Membership discovery returns only the authenticated user's active memberships", async () => {
  const tenantIds = Array.from({ length: 6 }, () => randomUUID());
  const membershipIds = Array.from({ length: 6 }, () => randomUUID());
  const now = new Date();
  const emptyUserEmail = `${randomUUID()}@example.invalid`;
  let emptyUserId;

  const loginUser = await migrator.query("SELECT id FROM users WHERE email_normalized = $1", [
    users.login,
  ]);
  const otherUser = await migrator.query("SELECT id FROM users WHERE email_normalized = $1", [
    users.logoutAll,
  ]);

  const userId = loginUser.rows[0].id;
  const otherUserId = otherUser.rows[0].id;

  try {
    for (let index = 0; index < tenantIds.length; index += 1) {
      await migrator.query(
        `INSERT INTO businesses (
           id, name, slug, status, default_currency, default_timezone, updated_at
         )
         VALUES ($1, $2, $3, $4, 'BDT', 'Asia/Dhaka', $5)`,
        [
          tenantIds[index],
          `Membership Discovery Business ${index}`,
          `membership-${tenantIds[index]}`,
          index === 4 ? "SUSPENDED" : "ACTIVE",
          now,
        ],
      );
    }

    const membershipFixtures = [
      [membershipIds[0], tenantIds[0], userId, "ACTIVE", now, null],
      [membershipIds[1], tenantIds[1], userId, "ACTIVE", now, null],
      [membershipIds[2], tenantIds[2], userId, "INVITED", null, null],
      [membershipIds[3], tenantIds[3], userId, "ACTIVE", now, now],
      [membershipIds[4], tenantIds[4], userId, "ACTIVE", now, null],
      [membershipIds[5], tenantIds[5], otherUserId, "ACTIVE", now, null],
    ];

    for (const [id, tenantId, memberId, status, joinedAt, leftAt] of membershipFixtures) {
      await migrator.query(
        `INSERT INTO tenant_memberships (
           id, tenant_id, user_id, status, joined_at, left_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, tenantId, memberId, status, joinedAt, leftAt, now],
      );
    }

    const unauthenticated = await fetch(`${apiBaseUrl}/api/v1/auth/memberships`);
    assert.equal(unauthenticated.status, 401);

    const loginResponse = await login(users.login);
    assert.equal(loginResponse.status, 200);

    const token = getCookie(loginResponse);
    const response = await fetch(`${apiBaseUrl}/api/v1/auth/memberships`, {
      headers: { Cookie: cookieHeader(token) },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");

    const body = await response.json();

    assert.deepEqual(
      body.memberships.map((membership) => membership.membershipId),
      [membershipIds[0], membershipIds[1]],
    );

    assert.deepEqual(
      body.memberships.map((membership) => membership.business.id),
      [tenantIds[0], tenantIds[1]],
    );
    assert.deepEqual(
      body.memberships.map((membership) => membership.business.name),
      ["Membership Discovery Business 0", "Membership Discovery Business 1"],
    );
    for (const membership of body.memberships) {
      assert.equal(membership.membershipStatus, "ACTIVE");
      assert.equal(membership.business.currency, "BDT");
      assert.equal(membership.business.timezone, "Asia/Dhaka");
    }

    emptyUserId = await createUser(emptyUserEmail);
    const emptyUserLogin = await login(emptyUserEmail);
    assert.equal(emptyUserLogin.status, 200);

    const emptyUserToken = getCookie(emptyUserLogin);
    const emptyResponse = await fetch(`${apiBaseUrl}/api/v1/auth/memberships`, {
      headers: { Cookie: cookieHeader(emptyUserToken) },
    });

    assert.equal(emptyResponse.status, 200);
    assert.deepEqual(await emptyResponse.json(), { memberships: [] });
  } finally {
    await migrator.query("DELETE FROM tenant_memberships WHERE tenant_id = ANY($1::uuid[])", [
      tenantIds,
    ]);
    await migrator.query("DELETE FROM businesses WHERE id = ANY($1::uuid[])", [tenantIds]);
    if (emptyUserId) {
      await migrator.query("DELETE FROM users WHERE id = $1", [emptyUserId]);
    }
  }
});

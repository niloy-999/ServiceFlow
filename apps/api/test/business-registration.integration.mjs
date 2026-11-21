import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "pg";

import { AppModule } from "../dist/app.module.js";
import { AuditService } from "../dist/audit/audit.service.js";
import { PrismaService } from "../dist/database/prisma.service.js";
import { CsrfService } from "../dist/identity/csrf.service.js";
import { SessionService } from "../dist/identity/session.service.js";

const frontendOrigin = new URL(process.env.WEB_APP_URL).origin;
const sessionCookieName = "__Host-serviceflow_session";

const users = {
  applicant: {
    id: randomUUID(),
    email: `${randomUUID()}@example.invalid`,
  },
  other: {
    id: randomUUID(),
    email: `${randomUUID()}@example.invalid`,
  },
  unverified: {
    id: randomUUID(),
    email: `${randomUUID()}@example.invalid`,
  },
};

const businessIds = [];

let app;
let migrator;
let sessions;
let csrf;
let prisma;
let auditService;
let apiBaseUrl;

function cookieHeader(token) {
  return `${sessionCookieName}=${token}`;
}

async function createSession(userId) {
  const session = await sessions.createSession(userId);

  return {
    token: session.token,
    csrfToken: csrf.generateToken(session.token),
    cookie: cookieHeader(session.token),
  };
}

async function createUser(user, verified = true) {
  await migrator.query(
    `INSERT INTO users (
       id,
       email_normalized,
       password_hash,
       display_name,
       email_verified_at,
       status,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW())`,
    [
      user.id,
      user.email,
      "test-only-not-a-real-password-hash",
      "Business Registration Integration User",
      verified ? new Date() : null,
    ],
  );
}

async function registerBusiness(session, name, headers = {}) {
  return fetch(`${apiBaseUrl}/api/v1/businesses/registrations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: frontendOrigin,
      Cookie: session.cookie,
      "X-CSRF-Token": session.csrfToken,
      ...headers,
    },
    body: JSON.stringify({ name }),
  });
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  assert.ok(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL is required");
  assert.ok(process.env.WEB_APP_URL, "WEB_APP_URL is required");
  assert.ok(process.env.CSRF_HMAC_SECRET, "CSRF_HMAC_SECRET is required");

  migrator = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });

  await migrator.connect();

  const migrationIdentity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );

  assert.equal(migrationIdentity.rows[0].role, "serviceflow_migrator");
  assert.equal(migrationIdentity.rows[0].database, "serviceflow_dev");

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");

  app.enableCors({
    origin: (origin, callback) => callback(null, origin === frontendOrigin),
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

  sessions = app.get(SessionService);
  csrf = app.get(CsrfService);

  prisma = app.get(PrismaService);
  auditService = app.get(AuditService);

  const appIdentity = await prisma.$queryRaw`
    SELECT current_user AS role, current_database() AS database
  `;

  assert.equal(appIdentity[0].role, "serviceflow_app");
  assert.equal(appIdentity[0].database, "serviceflow_dev");

  await createUser(users.applicant);
  await createUser(users.other);
  await createUser(users.unverified, false);
});

after(async () => {
  try {
    if (migrator) {
      await migrator.query("BEGIN");

      try {
        const testUserIds = [users.applicant.id, users.other.id, users.unverified.id];

        const ownedBusinesses = await migrator.query(
          "SELECT DISTINCT tenant_id FROM tenant_memberships WHERE user_id = ANY($1::uuid[])",
          [testUserIds],
        );

        const cleanupBusinessIds = [
          ...new Set([...businessIds, ...ownedBusinesses.rows.map((row) => row.tenant_id)]),
        ];

        // Test teardown only: temporarily disable immutability for fixture cleanup.
        await migrator.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable");

        await migrator.query(
          "DELETE FROM audit_events WHERE actor_user_id = ANY($1::uuid[]) OR tenant_id = ANY($2::uuid[])",
          [testUserIds, cleanupBusinessIds],
        );

        await migrator.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable");

        await migrator.query("DELETE FROM tenant_memberships WHERE user_id = ANY($1::uuid[])", [
          testUserIds,
        ]);

        if (cleanupBusinessIds.length > 0) {
          await migrator.query("DELETE FROM businesses WHERE id = ANY($1::uuid[])", [
            cleanupBusinessIds,
          ]);
        }

        await migrator.query("DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])", [
          [users.applicant.id, users.other.id, users.unverified.id],
        ]);

        await migrator.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
          [users.applicant.id, users.other.id, users.unverified.id],
        ]);

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

test("Business registration enforces authentication, origin, CSRF, and email verification", async () => {
  const unauthenticated = await fetch(`${apiBaseUrl}/api/v1/businesses/registrations`);

  assert.equal(unauthenticated.status, 401);

  const applicantSession = await createSession(users.applicant.id);
  const otherSession = await createSession(users.other.id);
  const unverifiedSession = await createSession(users.unverified.id);

  const missingCsrf = await registerBusiness(applicantSession, "Missing CSRF Business", {
    "X-CSRF-Token": "",
  });

  assert.equal(missingCsrf.status, 403);

  const foreignOrigin = await registerBusiness(applicantSession, "Foreign Origin Business", {
    Origin: "https://attacker.example",
  });

  assert.equal(foreignOrigin.status, 403);

  const unverified = await registerBusiness(unverifiedSession, "Unverified Applicant Business");

  assert.equal(unverified.status, 403);

  const invalidName = await registerBusiness(applicantSession, "A");

  assert.equal(invalidName.status, 400);
});

test("Verified users receive pending businesses and pending memberships", async () => {
  const applicantSession = await createSession(users.applicant.id);

  const response = await registerBusiness(applicantSession, "  Integration Test Business  ");

  assert.equal(response.status, 201);

  const result = await response.json();

  assert.equal(result.membershipStatus, "PENDING");
  assert.equal(result.business.name, "Integration Test Business");
  assert.equal(result.business.status, "PENDING");
  assert.equal(result.business.currency, "BDT");
  assert.equal(result.business.timezone, "Asia/Dhaka");
  assert.match(result.business.id, /^[0-9a-f-]{36}$/);
  assert.match(result.business.slug, /^integration-test-business-[a-f0-9]{12}$/);

  businessIds.push(result.business.id);

  const storedBusiness = await migrator.query("SELECT status FROM businesses WHERE id = $1", [
    result.business.id,
  ]);

  assert.equal(storedBusiness.rowCount, 1);
  assert.equal(storedBusiness.rows[0].status, "PENDING");

  const storedMembership = await migrator.query(
    `SELECT status, tenant_id, user_id
     FROM tenant_memberships
     WHERE id = $1`,
    [result.membershipId],
  );

  assert.equal(storedMembership.rowCount, 1);
  assert.equal(storedMembership.rows[0].status, "PENDING");
  assert.equal(storedMembership.rows[0].tenant_id, result.business.id);
  assert.equal(storedMembership.rows[0].user_id, users.applicant.id);

  const auditEvent = await migrator.query(
    `SELECT actor_type, actor_user_id, tenant_id, action, target_type, target_id, outcome
     FROM audit_events
     WHERE tenant_id = $1 AND action = $2`,
    [result.business.id, "business.registration.submitted"],
  );

  assert.equal(auditEvent.rowCount, 1);
  assert.equal(auditEvent.rows[0].actor_type, "USER");
  assert.equal(auditEvent.rows[0].actor_user_id, users.applicant.id);
  assert.equal(auditEvent.rows[0].tenant_id, result.business.id);
  assert.equal(auditEvent.rows[0].target_type, "business");
  assert.equal(auditEvent.rows[0].target_id, result.business.id);
  assert.equal(auditEvent.rows[0].outcome, "SUCCESS");
});

test("Registration history is private and pending memberships are not operational", async () => {
  const applicantSession = await createSession(users.applicant.id);
  const otherSession = await createSession(users.other.id);

  const applicantHistory = await fetch(`${apiBaseUrl}/api/v1/businesses/registrations`, {
    headers: { Cookie: applicantSession.cookie },
  });

  assert.equal(applicantHistory.status, 200);
  assert.equal(applicantHistory.headers.get("cache-control"), "no-store");

  const applicantBody = await applicantHistory.json();

  assert.equal(applicantBody.registrations.length, 1);
  assert.equal(applicantBody.registrations[0].business.name, "Integration Test Business");
  assert.equal(applicantBody.registrations[0].membershipStatus, "PENDING");

  const otherHistory = await fetch(`${apiBaseUrl}/api/v1/businesses/registrations`, {
    headers: { Cookie: otherSession.cookie },
  });

  assert.equal(otherHistory.status, 200);
  assert.deepEqual(await otherHistory.json(), { registrations: [] });

  const operationalMemberships = await fetch(`${apiBaseUrl}/api/v1/auth/memberships`, {
    headers: { Cookie: applicantSession.cookie },
  });

  assert.equal(operationalMemberships.status, 200);
  assert.deepEqual(await operationalMemberships.json(), { memberships: [] });
});

test("Global audit events require an empty tenant context", async () => {
  const eventId = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('app.user_id', ${users.other.id}, true)
    `;

    return auditService.record(tx, {
      actorUserId: users.other.id,
      tenantId: null,
      action: "platform.audit.global_test",
      targetType: "test",
      targetId: randomUUID(),
      outcome: "SUCCESS",
    });
  });

  const storedEvent = await migrator.query(
    `SELECT actor_type, actor_user_id, tenant_id, action, outcome
     FROM audit_events
     WHERE id = $1::uuid`,
    [eventId],
  );

  assert.equal(storedEvent.rowCount, 1);
  assert.equal(storedEvent.rows[0].actor_type, "USER");
  assert.equal(storedEvent.rows[0].actor_user_id, users.other.id);
  assert.equal(storedEvent.rows[0].tenant_id, null);
  assert.equal(storedEvent.rows[0].action, "platform.audit.global_test");
  assert.equal(storedEvent.rows[0].outcome, "SUCCESS");

  await assert.rejects(
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT set_config('app.user_id', ${users.other.id}, true)
      `;

      await tx.$queryRaw`
        SELECT set_config('app.tenant_id', ${randomUUID()}, true)
      `;

      return auditService.record(tx, {
        actorUserId: users.other.id,
        tenantId: null,
        action: "platform.audit.invalid_global_test",
        targetType: "test",
        targetId: randomUUID(),
        outcome: "SUCCESS",
      });
    }),
  );
});

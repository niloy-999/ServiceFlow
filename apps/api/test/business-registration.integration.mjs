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
import { GlobalIdentityContextService } from "../dist/database/global-identity-context.service.js";
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
let activatedBusinessId;
let identityContext;

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
  assert.equal(migrationIdentity.rows[0].database, "serviceflow_test");

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
  identityContext = app.get(GlobalIdentityContextService);

  const appIdentity = await prisma.$queryRaw`
    SELECT current_user AS role, current_database() AS database
  `;

  assert.equal(appIdentity[0].role, "serviceflow_app");
  assert.equal(appIdentity[0].database, "serviceflow_test");

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

        await migrator.query(
          "DELETE FROM membership_branch_scopes WHERE tenant_id = ANY($1::uuid[])",
          [cleanupBusinessIds],
        );
        await migrator.query("DELETE FROM membership_roles WHERE tenant_id = ANY($1::uuid[])", [
          cleanupBusinessIds,
        ]);
        await migrator.query("DELETE FROM role_permissions WHERE tenant_id = ANY($1::uuid[])", [
          cleanupBusinessIds,
        ]);
        await migrator.query("DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])", [
          cleanupBusinessIds,
        ]);
        await migrator.query("DELETE FROM branches WHERE tenant_id = ANY($1::uuid[])", [
          cleanupBusinessIds,
        ]);

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

        await migrator.query(
          "DELETE FROM platform_administrators WHERE user_id = ANY($1::uuid[])",
          [[users.applicant.id, users.other.id, users.unverified.id]],
        );
        await migrator.query("DELETE FROM user_mfa WHERE user_id = ANY($1::uuid[])", [
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
  activatedBusinessId = result.business.id;

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

test("Platform activation atomically provisions the initial owner workspace", async () => {
  assert.ok(activatedBusinessId);
  await migrator.query(
    `INSERT INTO platform_administrators (id, user_id, role, status, updated_at)
     VALUES ($1, $2, 'PLATFORM_ADMIN', 'ACTIVE', NOW())`,
    [randomUUID(), users.other.id],
  );
  for (const userId of [users.other.id, users.applicant.id]) {
    await migrator.query(
      `INSERT INTO user_mfa (id, user_id, encrypted_secret, status, enabled_at, updated_at)
       VALUES ($1, $2, $3, 'ENABLED', NOW() - INTERVAL '1 minute', NOW())`,
      [randomUUID(), userId, Buffer.alloc(32, 7)],
    );
  }
  const mfaFixtures = await migrator.query(
    "SELECT bool_and(status = 'ENABLED' AND enabled_at < NOW()) AS ready FROM user_mfa WHERE user_id = ANY($1::uuid[])",
    [[users.other.id, users.applicant.id]],
  );
  assert.equal(mfaFixtures.rows[0].ready, true);
  const runtimeMfa = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.user_id', ${users.other.id}, true)`;
    await tx.$queryRaw`SELECT set_config('app.tenant_id', '', true)`;
    return tx.userMfa.findUnique({
      where: { userId: users.other.id },
      select: { status: true, enabledAt: true },
    });
  });
  assert.equal(runtimeMfa?.status, "ENABLED");
  assert.ok(runtimeMfa?.enabledAt && runtimeMfa.enabledAt.getTime() < Date.now());

  const platformSession = await identityContext.withGlobalIdentityContext(
    { userId: users.other.id },
    (tx) => sessions.createMfaVerifiedSession(tx, users.other.id),
  );
  const platformCookie = cookieHeader(platformSession.token);
  const csrfToken = csrf.generateToken(platformSession.token);
  const activationUrl = `${apiBaseUrl}/api/v1/businesses/registrations/${activatedBusinessId}/activate`;
  const memberSession = await identityContext.withGlobalIdentityContext(
    { userId: users.applicant.id },
    (tx) => sessions.createMfaVerifiedSession(tx, users.applicant.id),
  );
  const forbiddenActivation = await fetch(activationUrl, {
    method: "POST",
    headers: {
      Origin: frontendOrigin,
      Cookie: cookieHeader(memberSession.token),
      "X-CSRF-Token": csrf.generateToken(memberSession.token),
    },
  });
  assert.equal(forbiddenActivation.status, 403);
  const activationRequests = await Promise.all(
    Array.from({ length: 2 }, () =>
      fetch(activationUrl, {
        method: "POST",
        headers: { Origin: frontendOrigin, Cookie: platformCookie, "X-CSRF-Token": csrfToken },
      }),
    ),
  );
  assert.deepEqual(activationRequests.map((response) => response.status).sort(), [201, 409]);
  const activation = activationRequests.find((response) => response.status === 201);
  assert.ok(activation);
  const activationBody = await activation.json();
  assert.equal(activation.status, 201, JSON.stringify(activationBody));
  assert.equal(activationBody.status, "ACTIVE");
  const ownerMemberships = await fetch(`${apiBaseUrl}/api/v1/auth/memberships`, {
    headers: { Cookie: cookieHeader(memberSession.token) },
  });
  assert.equal(ownerMemberships.status, 200);
  const discovered = await ownerMemberships.json();
  assert.equal(discovered.memberships.length, 1);
  assert.equal(discovered.memberships[0].business.id, activatedBusinessId);

  const provisioned = await migrator.query(
    `SELECT b.status AS business_status, tm.status AS membership_status,
            r.template_code, br.code AS branch_code, s.scope_type, s.can_operate
     FROM businesses b
     JOIN tenant_memberships tm ON tm.tenant_id = b.id
     JOIN membership_roles mr ON mr.tenant_id = tm.tenant_id AND mr.membership_id = tm.id
     JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
     JOIN branches br ON br.tenant_id = b.id
     JOIN membership_branch_scopes s ON s.tenant_id = tm.tenant_id AND s.membership_id = tm.id
     WHERE b.id = $1`,
    [activatedBusinessId],
  );
  assert.equal(provisioned.rowCount, 1);
  assert.equal(provisioned.rows[0].business_status, "ACTIVE");
  assert.equal(provisioned.rows[0].membership_status, "ACTIVE");
  assert.equal(provisioned.rows[0].template_code, "OWNER");
  assert.equal(provisioned.rows[0].branch_code, "MAIN");
  assert.equal(provisioned.rows[0].scope_type, "BUSINESS");
  assert.equal(provisioned.rows[0].can_operate, true);

  const audit = await migrator.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE tenant_id = $1 AND action = 'business.activated'",
    [activatedBusinessId],
  );
  assert.equal(audit.rows[0].count, 1);
});

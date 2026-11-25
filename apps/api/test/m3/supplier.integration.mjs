import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "pg";

import { AppModule } from "../../dist/app.module.js";
import { CsrfService } from "../../dist/identity/csrf.service.js";
import { SessionService } from "../../dist/identity/session.service.js";

const origin = new URL(process.env.WEB_APP_URL).origin;
const users = [randomUUID(), randomUUID()];
const tenantId = randomUUID();
const membershipIds = [randomUUID(), randomUUID()];
const roleIds = [randomUUID(), randomUUID()];
const cookieName = "__Host-serviceflow_session";

let app;
let migrator;
let runtime;
let sessions;
let csrf;
let apiBaseUrl;
let fixturesCreated = false;

async function createSession(userId) {
  const session = await sessions.createSession(userId);
  return {
    cookie: `${cookieName}=${session.token}`,
    csrf: csrf.generateToken(session.token),
  };
}

async function call(session, path, method = "GET", body, requestOptions = {}) {
  const {
    origin: requestOrigin = origin,
    csrfToken = session.csrf,
    includeOrigin = true,
    includeCsrf = true,
  } = requestOptions;

  return fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET"
        ? {}
        : {
            ...(includeOrigin ? { Origin: requestOrigin } : {}),
            ...(includeCsrf ? { "X-CSRF-Token": csrfToken } : {}),
          }),
      Cookie: session.cookie,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createFixtures() {
  await migrator.query("BEGIN");
  try {
    await migrator.query(
      `INSERT INTO businesses (id, name, slug, status, updated_at)
       VALUES ($1, 'M3 Supplier Test Tenant', $2, 'ACTIVE', NOW())`,
      [tenantId, `m3-supplier-${tenantId}`],
    );

    for (let index = 0; index < users.length; index += 1) {
      const userId = users[index];

      await migrator.query(
        `INSERT INTO users
          (id, email_normalized, password_hash, display_name, email_verified_at, status, updated_at)
         VALUES ($1, $2, 'not-a-real-hash', 'M3 Supplier Test User', NOW(), 'ACTIVE', NOW())`,
        [userId, `${userId}@example.invalid`],
      );

      await migrator.query(
        `INSERT INTO tenant_memberships
          (id, tenant_id, user_id, status, joined_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
        [membershipIds[index], tenantId, userId],
      );

      await migrator.query(
        `INSERT INTO roles
          (id, tenant_id, name, is_system, status, template_code, updated_at)
         VALUES ($1, $2, $3, false, 'ACTIVE', $4, NOW())`,
        [
          roleIds[index],
          tenantId,
          index === 0 ? "M3 Supplier Manager" : "M3 Supplier Reader",
          index === 0 ? "M3_SUPPLIER_MANAGER" : "M3_SUPPLIER_READER",
        ],
      );
    }

    await migrator.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
       VALUES
         ($1, $2, 'supplier.read'),
         ($1, $2, 'supplier.manage'),
         ($1, $3, 'supplier.read')`,
      [tenantId, roleIds[0], roleIds[1]],
    );

    await migrator.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [tenantId, membershipIds[0], roleIds[0], membershipIds[1], roleIds[1]],
    );

    await migrator.query(
      `INSERT INTO membership_branch_scopes
        (id, tenant_id, membership_id, scope_type, branch_id, can_view, can_operate)
       VALUES
         ($1, $2, $3, 'BUSINESS', NULL, true, true),
         ($4, $2, $5, 'BUSINESS', NULL, true, false)`,
      [randomUUID(), tenantId, membershipIds[0], randomUUID(), membershipIds[1]],
    );

    await migrator.query("COMMIT");
    fixturesCreated = true;
  } catch (error) {
    await migrator.query("ROLLBACK");
    throw error;
  }
}

async function cleanupFixtures() {
  await migrator.query("BEGIN");
  try {
    await migrator.query("ALTER TABLE suppliers DISABLE TRIGGER USER");
    await migrator.query("DELETE FROM suppliers WHERE tenant_id = $1", [tenantId]);
    await migrator.query("ALTER TABLE suppliers ENABLE TRIGGER USER");

    await migrator.query("DELETE FROM membership_branch_scopes WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM membership_roles WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM role_permissions WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM roles WHERE tenant_id = $1", [tenantId]);

    await migrator.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable");
    await migrator.query(
      "DELETE FROM audit_events WHERE tenant_id = $1 OR actor_user_id = ANY($2::uuid[])",
      [tenantId, users],
    );
    await migrator.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable");

    await migrator.query("DELETE FROM tenant_memberships WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM businesses WHERE id = $1", [tenantId]);
    await migrator.query("DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])", [users]);
    await migrator.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);

    await migrator.query("COMMIT");
  } catch (error) {
    await migrator.query("ROLLBACK");
    throw error;
  }
}

before(async () => {
  assert.ok(process.env.DATABASE_URL);
  assert.ok(process.env.MIGRATION_DATABASE_URL);
  assert.ok(process.env.WEB_APP_URL);

  const expectedTestDatabase = process.env.SERVICEFLOW_TEST_DATABASE ?? "serviceflow_m3_test";

  assert.match(
    expectedTestDatabase,
    /^serviceflow_m3_[a-z0-9_]+$/,
    "Integration tests must use a dedicated M3 test database.",
  );

  migrator = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });
  await migrator.connect();

  const migrationIdentity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(migrationIdentity.rows[0].role, "serviceflow_migrator");
  assert.equal(migrationIdentity.rows[0].database, expectedTestDatabase);

  runtime = new Client({
    connectionString: process.env.DATABASE_URL,
  });
  await runtime.connect();

  const runtimeIdentity = await runtime.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(runtimeIdentity.rows[0].role, "serviceflow_app");
  assert.equal(runtimeIdentity.rows[0].database, expectedTestDatabase);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  app.enableCors({
    origin: (requestOrigin, callback) => callback(null, requestOrigin === origin),
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
  apiBaseUrl = `http://127.0.0.1:${app.getHttpServer().address().port}`;
  sessions = app.get(SessionService);
  csrf = app.get(CsrfService);

  await createFixtures();
});

after(async () => {
  try {
    if (migrator && fixturesCreated) {
      await cleanupFixtures();
    }
  } finally {
    if (app) await app.close();
    if (runtime) await runtime.end();
    if (migrator) await migrator.end();
  }
});

test("Supplier CRUD enforces permissions, tenant isolation, versions, normalization and audit", async () => {
  const owner = await createSession(users[0]);
  const reader = await createSession(users[1]);

  const emptyList = await call(owner, `/api/v1/suppliers/${tenantId}`);
  assert.equal(emptyList.status, 200);
  assert.deepEqual((await emptyList.json()).suppliers, []);

  const readerList = await call(reader, `/api/v1/suppliers/${tenantId}`);
  assert.equal(readerList.status, 200);

  const readOnlyMutation = await call(reader, "/api/v1/suppliers", "POST", {
    tenantId,
    name: "Reader must not create",
  });
  assert.equal(readOnlyMutation.status, 403);

  const crossTenant = await call(owner, `/api/v1/suppliers/${randomUUID()}`);
  assert.equal(crossTenant.status, 403);

  const createdResponse = await call(owner, "/api/v1/suppliers", "POST", {
    tenantId,
    name: "  Example Components Ltd  ",
    contactName: "  Accounts Team ",
    email: "sales@example.invalid",
    phone: " +880 1000 ",
    notes: "Primary distributor",
  });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());

  const created = await createdResponse.json();
  assert.equal(created.name, "Example Components Ltd");
  assert.equal(created.contactName, "Accounts Team");
  assert.equal(created.email, "sales@example.invalid");
  assert.equal(created.version, "1");

  const duplicate = await call(owner, "/api/v1/suppliers", "POST", {
    tenantId,
    name: "example components ltd",
  });
  assert.equal(duplicate.status, 409);

  const unicodeName = await call(owner, "/api/v1/suppliers", "POST", {
    tenantId,
    name: "Straße Supplies",
  });
  assert.equal(unicodeName.status, 201, await unicodeName.clone().text());

  const unicodeSupplier = await unicodeName.json();
  assert.equal(unicodeSupplier.name, "Straße Supplies");

  const unicodeStored = await migrator.query(
    `SELECT name_normalized
     FROM suppliers
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, unicodeSupplier.id],
  );
  assert.equal(unicodeStored.rows[0].name_normalized, "STRAẞE SUPPLIES");

  const unicodeDuplicate = await call(owner, "/api/v1/suppliers", "POST", {
    tenantId,
    name: "STRAẞE SUPPLIES",
  });
  assert.equal(unicodeDuplicate.status, 409);

  await assert.rejects(
    migrator.query(
      `INSERT INTO suppliers (
         id, tenant_id, name, name_normalized, updated_at
       )
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)`,
      [randomUUID(), tenantId, "Constraint Probe", "INCORRECT NORMALIZED VALUE"],
    ),
    (error) => error.code === "23514" && error.constraint === "suppliers_name_normalized_check",
  );

  const nullName = await call(owner, `/api/v1/suppliers/${created.id}/update`, "POST", {
    tenantId,
    version: 1,
    name: null,
  });
  assert.equal(nullName.status, 400);

  const updatedResponse = await call(owner, `/api/v1/suppliers/${created.id}/update`, "POST", {
    tenantId,
    version: 1,
    name: "Example Components International",
    email: null,
    notes: null,
  });
  assert.equal(updatedResponse.status, 201, await updatedResponse.clone().text());

  const updated = await updatedResponse.json();
  assert.equal(updated.name, "Example Components International");
  assert.equal(updated.email, null);
  assert.equal(updated.notes, null);
  assert.equal(updated.version, "2");

  const stale = await call(owner, `/api/v1/suppliers/${created.id}/update`, "POST", {
    tenantId,
    version: 1,
    name: "Stale supplier edit",
  });
  assert.equal(stale.status, 409);

  const concurrent = await Promise.all([
    call(owner, `/api/v1/suppliers/${created.id}/update`, "POST", {
      tenantId,
      version: 2,
      phone: "111",
    }),
    call(owner, `/api/v1/suppliers/${created.id}/update`, "POST", {
      tenantId,
      version: 2,
      phone: "222",
    }),
  ]);

  assert.deepEqual(
    concurrent.map((response) => response.status).sort((a, b) => a - b),
    [201, 409],
  );

  const current = await migrator.query(
    `SELECT version::text AS version, phone
     FROM suppliers
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, created.id],
  );
  assert.equal(current.rows[0].version, "3");
  assert.ok(["111", "222"].includes(current.rows[0].phone));

  const archivedResponse = await call(owner, `/api/v1/suppliers/${created.id}/archive`, "POST", {
    tenantId,
    version: 3,
  });
  assert.equal(archivedResponse.status, 201, await archivedResponse.clone().text());

  const archived = await archivedResponse.json();
  assert.equal(archived.status, "ARCHIVED");
  assert.equal(archived.version, "4");

  const unavailable = await call(owner, `/api/v1/suppliers/${created.id}/update`, "POST", {
    tenantId,
    version: 4,
    name: "Cannot update archived supplier",
  });
  assert.equal(unavailable.status, 404);

  const audit = await migrator.query(
    `SELECT action
     FROM audit_events
     WHERE tenant_id = $1
       AND target_id = $2
       AND action LIKE 'supplier.%'
     ORDER BY occurred_at, id`,
    [tenantId, created.id],
  );

  assert.deepEqual(
    audit.rows.map((row) => row.action),
    ["supplier.created", "supplier.updated", "supplier.updated", "supplier.archived"],
  );
});

test("Supplier endpoints reject malformed UUID path parameters", async () => {
  const owner = await createSession(users[0]);

  const invalidTenant = await call(owner, "/api/v1/suppliers/not-a-uuid");
  assert.equal(invalidTenant.status, 400);

  const invalidSupplier = await call(owner, "/api/v1/suppliers/not-a-uuid/update", "POST", {
    tenantId,
    version: 1,
    name: "Invalid path",
  });
  assert.equal(invalidSupplier.status, 400);
});

test("Supplier mutations reject missing CSRF, invalid CSRF, untrusted origins and unknown fields", async () => {
  const owner = await createSession(users[0]);

  const missingCsrf = await call(
    owner,
    "/api/v1/suppliers",
    "POST",
    { tenantId, name: "Missing CSRF Probe" },
    { includeCsrf: false },
  );
  assert.equal(missingCsrf.status, 403);

  const invalidCsrf = await call(
    owner,
    "/api/v1/suppliers",
    "POST",
    { tenantId, name: "Invalid CSRF Probe" },
    { csrfToken: "invalid-csrf-token" },
  );
  assert.equal(invalidCsrf.status, 403);

  const untrustedOrigin = await call(
    owner,
    "/api/v1/suppliers",
    "POST",
    { tenantId, name: "Untrusted Origin Probe" },
    { origin: ["https", "attacker.example.invalid"].join("://") },
  );
  assert.equal(untrustedOrigin.status, 403);

  const unknownField = await call(owner, "/api/v1/suppliers", "POST", {
    tenantId,
    name: "Unknown Field Probe",
    isPlatformAdmin: true,
  });
  assert.equal(unknownField.status, 400);

  const persisted = await migrator.query(
    `SELECT count(*)::int AS count
     FROM suppliers
     WHERE tenant_id = $1
       AND name IN (
         'Missing CSRF Probe',
         'Invalid CSRF Probe',
         'Untrusted Origin Probe',
         'Unknown Field Probe'
       )`,
    [tenantId],
  );
  assert.equal(persisted.rows[0].count, 0);
});

test("Supplier creation rolls back when its audit event cannot be written", async () => {
  const owner = await createSession(users[0]);
  const supplierName = "Audit Rollback Probe";
  const triggerName = "test_reject_supplier_created_audit";
  const functionName = "test_reject_supplier_created_audit";

  const beforeSupplier = await migrator.query(
    `SELECT count(*)::int AS count
     FROM suppliers
     WHERE tenant_id = $1 AND name = $2`,
    [tenantId, supplierName],
  );
  assert.equal(beforeSupplier.rows[0].count, 0);

  const beforeAudit = await migrator.query(
    `SELECT count(*)::int AS count
     FROM audit_events
     WHERE tenant_id = $1 AND action = 'supplier.created'`,
    [tenantId],
  );
  const auditCountBefore = beforeAudit.rows[0].count;

  await migrator.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_events`);
  await migrator.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);

  try {
    await migrator.query(`
      CREATE FUNCTION public.${functionName}()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.action = 'supplier.created' THEN
          RAISE EXCEPTION 'Intentional supplier audit failure'
            USING ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
      END;
      $$
    `);

    await migrator.query(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON audit_events
      FOR EACH ROW
      EXECUTE FUNCTION public.${functionName}()
    `);

    const response = await call(owner, "/api/v1/suppliers", "POST", {
      tenantId,
      name: supplierName,
    });

    assert.equal(response.status, 500, await response.clone().text());

    const afterSupplier = await migrator.query(
      `SELECT count(*)::int AS count
       FROM suppliers
       WHERE tenant_id = $1 AND name = $2`,
      [tenantId, supplierName],
    );
    assert.equal(afterSupplier.rows[0].count, 0);

    const afterAudit = await migrator.query(
      `SELECT count(*)::int AS count
       FROM audit_events
       WHERE tenant_id = $1 AND action = 'supplier.created'`,
      [tenantId],
    );
    assert.equal(afterAudit.rows[0].count, auditCountBefore);
  } finally {
    await migrator.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_events`);
    await migrator.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
  }
});

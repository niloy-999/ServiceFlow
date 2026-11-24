import "dotenv/config";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Client } from "pg";

import { AppModule } from "../dist/app.module.js";
import { CsrfService } from "../dist/identity/csrf.service.js";
import { SessionService } from "../dist/identity/session.service.js";

const origin = new URL(process.env.WEB_APP_URL).origin;
const tenantId = randomUUID();
const branchId = randomUUID();
const users = [randomUUID(), randomUUID(), randomUUID()];
const memberships = users.map(() => randomUUID());
const roles = users.map(() => randomUUID());
const cookieName = "__Host-serviceflow_session";

const permissions = [
  [
    "catalogue.read",
    "catalogue.manage",
    "inventory.read",
    "inventory.adjust",
    "inventory.adjust.approve",
  ],
  ["inventory.read", "inventory.adjust.approve", "inventory.override_negative"],
  ["inventory.read", "inventory.adjust.approve"],
];

let app;
let migrator;
let runtime;
let sessions;
let csrf;
let apiBaseUrl;
let fixturesCreated = false;

const idempotencyKey = () => randomUUID();

async function createSession(userId) {
  const session = await sessions.createSession(userId);
  return {
    cookie: `${cookieName}=${session.token}`,
    csrf: csrf.generateToken(session.token),
  };
}

async function call(session, path, method = "GET", body) {
  return fetch(`${apiBaseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(method === "GET" ? {} : { Origin: origin, "X-CSRF-Token": session.csrf }),
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
       VALUES ($1, 'Inventory Integration Tenant', $2, 'ACTIVE', NOW())`,
      [tenantId, `inventory-${tenantId}`],
    );

    for (let i = 0; i < users.length; i += 1) {
      await migrator.query(
        `INSERT INTO users
         (id, email_normalized, password_hash, display_name,
          email_verified_at, status, updated_at)
         VALUES ($1, $2, 'not-a-real-hash', 'Inventory Test User', NOW(), 'ACTIVE', NOW())`,
        [users[i], `${users[i]}@example.invalid`],
      );

      await migrator.query(
        `INSERT INTO tenant_memberships
         (id, tenant_id, user_id, status, joined_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
        [memberships[i], tenantId, users[i]],
      );

      await migrator.query(
        `INSERT INTO roles
         (id, tenant_id, name, is_system, status, template_code, updated_at)
         VALUES ($1, $2, $3, false, 'ACTIVE', $4, NOW())`,
        [roles[i], tenantId, `Inventory test role ${i}`, `INVENTORY_TEST_${i}`],
      );

      for (const permission of permissions[i]) {
        await migrator.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
           VALUES ($1, $2, $3)`,
          [tenantId, roles[i], permission],
        );
      }

      await migrator.query(
        `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
         VALUES ($1, $2, $3)`,
        [tenantId, memberships[i], roles[i]],
      );

      await migrator.query(
        `INSERT INTO membership_branch_scopes
         (id, tenant_id, membership_id, scope_type, branch_id, can_view, can_operate)
         VALUES ($1, $2, $3, 'BUSINESS', NULL, true, true)`,
        [randomUUID(), tenantId, memberships[i]],
      );
    }

    await migrator.query(
      `INSERT INTO branches (id, tenant_id, code, name, updated_at)
       VALUES ($1, $2, 'INVENTORY', 'Inventory test branch', NOW())`,
      [branchId, tenantId],
    );

    await migrator.query("COMMIT");
    fixturesCreated = true;
  } catch (error) {
    await migrator.query("ROLLBACK");
    throw error;
  }
}

async function createProduct(session, { code, trackSerials = false }) {
  const response = await call(session, "/api/v1/catalogue/products", "POST", {
    tenantId,
    productCode: code,
    name: `Inventory test ${code}`,
    productKind: "RETAIL",
    trackSerials,
    sku: `${code}-SKU`,
  });

  assert.equal(response.status, 201, await response.clone().text());
  const product = await response.json();

  assert.equal(product.variants.length, 1);
  assert.equal(product.variants[0].isDefault, true);

  return {
    productId: product.id,
    variantId: product.variants[0].id,
  };
}

function adjustmentBody(product, quantityDelta, reason, key, serialChanges) {
  return {
    tenantId,
    branchId,
    productId: product.productId,
    variantId: product.variantId,
    quantityDelta,
    reason,
    idempotencyKey: key,
    ...(serialChanges === undefined ? {} : { serialChanges }),
  };
}

async function cleanupFixtures() {
  await migrator.query("BEGIN");

  try {
    // Disable only user-defined triggers. Internal FK triggers remain enabled.
    for (const table of [
      "inventory_serial_units",
      "inventory_ledger_entries",
      "inventory_adjustments",
      "inventory_operations",
      "inventory_balances",
      "product_prices",
      "audit_events",
    ]) {
      await migrator.query(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
    }

    await migrator.query("DELETE FROM inventory_serial_units WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM inventory_ledger_entries WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM inventory_adjustments WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM inventory_operations WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM inventory_balances WHERE tenant_id = $1", [tenantId]);

    await migrator.query("DELETE FROM product_prices WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM product_identifiers WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM product_variants WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]);

    await migrator.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);

    for (const table of [
      "inventory_serial_units",
      "inventory_ledger_entries",
      "inventory_adjustments",
      "inventory_operations",
      "inventory_balances",
      "product_prices",
      "audit_events",
    ]) {
      await migrator.query(`ALTER TABLE "${table}" ENABLE TRIGGER USER`);
    }

    await migrator.query("DELETE FROM membership_branch_scopes WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM membership_roles WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM role_permissions WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM roles WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM branches WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM tenant_memberships WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])", [users]);
    await migrator.query("DELETE FROM businesses WHERE id = $1", [tenantId]);
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

  migrator = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();

  const migrationIdentity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(migrationIdentity.rows[0].role, "serviceflow_migrator");
  assert.equal(migrationIdentity.rows[0].database, "serviceflow_test");

  runtime = new Client({ connectionString: process.env.DATABASE_URL });
  await runtime.connect();

  const runtimeIdentity = await runtime.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(runtimeIdentity.rows[0].role, "serviceflow_app");
  assert.equal(runtimeIdentity.rows[0].database, "serviceflow_test");

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    if (migrator && fixturesCreated) await cleanupFixtures();
  } finally {
    if (app) await app.close();
    if (runtime) await runtime.end();
    if (migrator) await migrator.end();
  }
});

test("Malformed inventory URL UUIDs return HTTP 400", async () => {
  const session = await createSession(users[1]);
  const invalid = "not-a-uuid";

  const cases = [
    { path: `/api/v1/inventory/${invalid}/branches/${branchId}/adjustments`, method: "GET" },
    { path: `/api/v1/inventory/${tenantId}/branches/${invalid}/adjustments`, method: "GET" },
    {
      path: `/api/v1/inventory/${tenantId}/branches/${branchId}/adjustments/${invalid}`,
      method: "GET",
    },
    { path: `/api/v1/inventory/adjustments/${invalid}/approve`, method: "POST" },
    { path: `/api/v1/inventory/adjustments/${invalid}/reject`, method: "POST" },
  ];

  for (const item of cases) {
    const response = await call(
      session,
      item.path,
      item.method,
      item.method === "POST"
        ? {
            tenantId,
            branchId,
            idempotencyKey: idempotencyKey(),
          }
        : undefined,
    );
    assert.equal(response.status, 400, `${item.method} ${item.path}: ${await response.text()}`);
  }
});

test("Adjustment submission is pending and approval posts one ledger movement", async () => {
  const requester = await createSession(users[0]);
  const approver = await createSession(users[1]);
  const product = await createProduct(requester, { code: `APPROVE-${randomUUID()}` });
  const submitKey = idempotencyKey();

  const body = adjustmentBody(product, 5, "Opening stock correction", submitKey);
  const submittedResponse = await call(requester, "/api/v1/inventory/adjustments", "POST", body);

  assert.equal(submittedResponse.status, 201, await submittedResponse.clone().text());
  const submitted = await submittedResponse.json();
  assert.equal(submitted.status, "PENDING");

  const beforeApproval = await migrator.query(
    "SELECT count(*)::int AS count FROM inventory_ledger_entries WHERE tenant_id = $1",
    [tenantId],
  );
  assert.equal(beforeApproval.rows[0].count, 0);

  const selfApproval = await call(
    requester,
    `/api/v1/inventory/adjustments/${submitted.id}/approve`,
    "POST",
    { tenantId, branchId, idempotencyKey: idempotencyKey() },
  );
  assert.equal(selfApproval.status, 409);

  const approvedResponse = await call(
    approver,
    `/api/v1/inventory/adjustments/${submitted.id}/approve`,
    "POST",
    { tenantId, branchId, idempotencyKey: idempotencyKey() },
  );
  assert.equal(approvedResponse.status, 201, await approvedResponse.clone().text());

  const approved = await approvedResponse.json();
  assert.equal(Number(approved.physicalQuantity), 5);

  const ledger = await migrator.query(
    `SELECT quantity_delta, balance_after
     FROM inventory_ledger_entries
     WHERE tenant_id = $1 AND adjustment_id = $2`,
    [tenantId, submitted.id],
  );
  assert.deepEqual(ledger.rows, [{ quantity_delta: 5, balance_after: 5 }]);

  // A retry with the same key and request must return the original operation result.
  const replayResponse = await call(requester, "/api/v1/inventory/adjustments", "POST", body);
  assert.equal(replayResponse.status, 201, await replayResponse.clone().text());
  const replay = await replayResponse.json();
  assert.equal(replay.id, submitted.id);

  const operations = await migrator.query(
    `SELECT count(*)::int AS count
     FROM inventory_operations
     WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, submitKey],
  );
  assert.equal(operations.rows[0].count, 1);
});

test("Concurrent approvals with the same idempotency key replay one operation", async () => {
  const requester = await createSession(users[0]);
  const approver = await createSession(users[1]);
  const product = await createProduct(requester, {
    code: `SAME-KEY-${randomUUID()}`,
  });

  const submittedResponse = await call(
    requester,
    "/api/v1/inventory/adjustments",
    "POST",
    adjustmentBody(product, 4, "Concurrent same-key approval", idempotencyKey()),
  );
  assert.equal(submittedResponse.status, 201, await submittedResponse.clone().text());
  const submitted = await submittedResponse.json();

  const approvalKey = idempotencyKey();
  const approvalBody = {
    tenantId,
    branchId,
    idempotencyKey: approvalKey,
  };
  const approvalPath = `/api/v1/inventory/adjustments/${submitted.id}/approve`;

  const responses = await Promise.all([
    call(approver, approvalPath, "POST", approvalBody),
    call(approver, approvalPath, "POST", approvalBody),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status),
    [201, 201],
    "Both identical concurrent requests should receive the original successful result",
  );

  const results = await Promise.all(responses.map((response) => response.json()));
  assert.equal(results[0].id, submitted.id);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].status, "APPROVED");
  assert.equal(Number(results[0].physicalQuantity), 4);

  const stored = await migrator.query(
    `SELECT
       (SELECT count(*)::int
        FROM inventory_operations
        WHERE tenant_id = $1 AND idempotency_key = $2) AS operations,
       (SELECT count(*)::int
        FROM inventory_ledger_entries
        WHERE tenant_id = $1 AND adjustment_id = $3) AS ledger_entries`,
    [tenantId, approvalKey, submitted.id],
  );

  assert.equal(stored.rows[0].operations, 1);
  assert.equal(stored.rows[0].ledger_entries, 1);
});

test("Concurrent approvals with different idempotency keys decide an adjustment once", async () => {
  const requester = await createSession(users[0]);
  const approver = await createSession(users[1]);
  const product = await createProduct(requester, {
    code: `DIFFERENT-KEYS-${randomUUID()}`,
  });

  const submittedResponse = await call(
    requester,
    "/api/v1/inventory/adjustments",
    "POST",
    adjustmentBody(product, 6, "Concurrent different-key approval", idempotencyKey()),
  );
  assert.equal(submittedResponse.status, 201, await submittedResponse.clone().text());
  const submitted = await submittedResponse.json();

  const approvalKeys = [idempotencyKey(), idempotencyKey()];
  const approvalPath = `/api/v1/inventory/adjustments/${submitted.id}/approve`;

  const responses = await Promise.all(
    approvalKeys.map((key) =>
      call(approver, approvalPath, "POST", {
        tenantId,
        branchId,
        idempotencyKey: key,
      }),
    ),
  );

  assert.deepEqual(
    responses.map((response) => response.status).sort((a, b) => a - b),
    [201, 409],
    "Exactly one concurrent approval should succeed",
  );

  const successfulResponse = responses.find((response) => response.status === 201);
  assert.ok(successfulResponse);
  const successfulResult = await successfulResponse.json();
  assert.equal(successfulResult.id, submitted.id);
  assert.equal(successfulResult.status, "APPROVED");
  assert.equal(Number(successfulResult.physicalQuantity), 6);

  const stored = await migrator.query(
    `SELECT
       (SELECT count(*)::int
        FROM inventory_operations
        WHERE tenant_id = $1
          AND idempotency_key = ANY($2::text[])) AS operations,
       (SELECT count(*)::int
        FROM inventory_ledger_entries
        WHERE tenant_id = $1 AND adjustment_id = $3) AS ledger_entries`,
    [tenantId, approvalKeys, submitted.id],
  );

  assert.equal(stored.rows[0].operations, 1);
  assert.equal(stored.rows[0].ledger_entries, 1);
});

test("Rejected adjustments do not create ledger movements", async () => {
  const requester = await createSession(users[0]);
  const approver = await createSession(users[1]);
  const product = await createProduct(requester, { code: `REJECT-${randomUUID()}` });

  const submittedResponse = await call(
    requester,
    "/api/v1/inventory/adjustments",
    "POST",
    adjustmentBody(product, 3, "Incorrect delivery count", idempotencyKey()),
  );
  assert.equal(submittedResponse.status, 201, await submittedResponse.clone().text());

  const submitted = await submittedResponse.json();
  const rejectedResponse = await call(
    approver,
    `/api/v1/inventory/adjustments/${submitted.id}/reject`,
    "POST",
    {
      tenantId,
      branchId,
      idempotencyKey: idempotencyKey(),
      decisionReason: "Supporting evidence was not provided",
    },
  );

  assert.equal(rejectedResponse.status, 201, await rejectedResponse.clone().text());

  const stored = await migrator.query(
    "SELECT status FROM inventory_adjustments WHERE tenant_id = $1 AND id = $2",
    [tenantId, submitted.id],
  );
  assert.equal(stored.rows[0].status, "REJECTED");

  const ledger = await migrator.query(
    "SELECT count(*)::int AS count FROM inventory_ledger_entries WHERE tenant_id = $1 AND adjustment_id = $2",
    [tenantId, submitted.id],
  );
  assert.equal(ledger.rows[0].count, 0);
});

test("Negative available stock requires the separate override permission and a reason", async () => {
  const requester = await createSession(users[0]);
  const approver = await createSession(users[1]);
  const limitedApprover = await createSession(users[2]);
  const product = await createProduct(requester, { code: `OVERRIDE-${randomUUID()}` });

  const openingResponse = await call(
    requester,
    "/api/v1/inventory/adjustments",
    "POST",
    adjustmentBody(product, 2, "Opening quantity", idempotencyKey()),
  );
  assert.equal(openingResponse.status, 201, await openingResponse.clone().text());
  const opening = await openingResponse.json();

  const openingApproval = await call(
    approver,
    `/api/v1/inventory/adjustments/${opening.id}/approve`,
    "POST",
    { tenantId, branchId, idempotencyKey: idempotencyKey() },
  );
  assert.equal(openingApproval.status, 201, await openingApproval.clone().text());

  // Reserved quantity is a projection input; changing it does not alter the physical ledger.
  await migrator.query(
    `UPDATE inventory_balances
     SET reserved_quantity = 3, updated_at = NOW(), version = version + 1
     WHERE tenant_id = $1 AND branch_id = $2 AND variant_id = $3`,
    [tenantId, branchId, product.variantId],
  );

  const negativeResponse = await call(
    requester,
    "/api/v1/inventory/adjustments",
    "POST",
    adjustmentBody(product, -1, "Damaged item", idempotencyKey()),
  );
  assert.equal(negativeResponse.status, 201, await negativeResponse.clone().text());
  const negative = await negativeResponse.json();

  const denied = await call(
    limitedApprover,
    `/api/v1/inventory/adjustments/${negative.id}/approve`,
    "POST",
    {
      tenantId,
      branchId,
      idempotencyKey: idempotencyKey(),
      negativeStockReason: "Permission-check test reason",
    },
  );
  assert.equal(denied.status, 403);

  const missingReason = await call(
    approver,
    `/api/v1/inventory/adjustments/${negative.id}/approve`,
    "POST",
    { tenantId, branchId, idempotencyKey: idempotencyKey() },
  );
  assert.equal(missingReason.status, 400);

  const approved = await call(
    approver,
    `/api/v1/inventory/adjustments/${negative.id}/approve`,
    "POST",
    {
      tenantId,
      branchId,
      idempotencyKey: idempotencyKey(),
      negativeStockReason: "Approved exception for reserved stock discrepancy",
    },
  );
  assert.equal(approved.status, 201, await approved.clone().text());

  const balance = await migrator.query(
    `SELECT physical_quantity, reserved_quantity
     FROM inventory_balances
     WHERE tenant_id = $1 AND branch_id = $2 AND variant_id = $3`,
    [tenantId, branchId, product.variantId],
  );
  assert.equal(balance.rows[0].physical_quantity, 1);
  assert.equal(balance.rows[0].reserved_quantity, 3);

  const overrideAudit = await migrator.query(
    `SELECT metadata
     FROM audit_events
     WHERE tenant_id = $1
       AND action LIKE '%override%'
     ORDER BY occurred_at DESC
     LIMIT 1`,
    [tenantId],
  );
  assert.ok(overrideAudit.rows.length > 0);
  assert.equal(
    overrideAudit.rows[0].metadata.reason,
    "Approved exception for reserved stock discrepancy",
  );
});

test("Serial-tracked adjustments require unique serials and reconcile serial units", async () => {
  const requester = await createSession(users[0]);
  const approver = await createSession(users[1]);
  const product = await createProduct(requester, {
    code: `SERIAL-${randomUUID()}`,
    trackSerials: true,
  });

  const invalid = await call(
    requester,
    "/api/v1/inventory/adjustments",
    "POST",
    adjustmentBody(product, 2, "Receive serialized units", idempotencyKey(), [
      { action: "ADD", serial: "SN-001" },
    ]),
  );
  assert.equal(invalid.status, 400);

  const submittedResponse = await call(
    requester,
    "/api/v1/inventory/adjustments",
    "POST",
    adjustmentBody(product, 2, "Receive serialized units", idempotencyKey(), [
      { action: "ADD", serial: " sn-001 " },
      { action: "ADD", serial: "sn-002" },
    ]),
  );
  assert.equal(submittedResponse.status, 201, await submittedResponse.clone().text());
  const submitted = await submittedResponse.json();

  const approvedResponse = await call(
    approver,
    `/api/v1/inventory/adjustments/${submitted.id}/approve`,
    "POST",
    { tenantId, branchId, idempotencyKey: idempotencyKey() },
  );
  assert.equal(approvedResponse.status, 201, await approvedResponse.clone().text());

  const serials = await migrator.query(
    `SELECT serial_normalized, status
     FROM inventory_serial_units
     WHERE tenant_id = $1 AND variant_id = $2
     ORDER BY serial_normalized`,
    [tenantId, product.variantId],
  );
  assert.deepEqual(serials.rows, [
    { serial_normalized: "SN-001", status: "IN_STOCK" },
    { serial_normalized: "SN-002", status: "IN_STOCK" },
  ]);

  // The database must reject a proposal whose serial identifiers do not
  // correspond exactly to the serial rows created by the approved adjustment.
  await migrator.query("BEGIN");
  try {
    await migrator.query('ALTER TABLE "inventory_adjustments" DISABLE TRIGGER USER');

    await migrator.query(
      `UPDATE inventory_adjustments
       SET serial_changes = $3::jsonb
       WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        submitted.id,
        JSON.stringify([
          { action: "ADD", serial: "SN-FAKE-001" },
          { action: "ADD", serial: "SN-FAKE-002" },
        ]),
      ],
    );

    await assert.rejects(
      migrator.query(`SELECT public.assert_inventory_serial_adjustment_count($1, $2)`, [
        tenantId,
        submitted.id,
      ]),
      (error) => error.code === "23514",
      "The database must reject serial identifiers absent from the approved proposal's actual serial rows",
    );
  } finally {
    await migrator.query("ROLLBACK");
  }

  // Remove one actual serial through a separate maker-checker adjustment.
  const removalResponse = await call(
    requester,
    "/api/v1/inventory/adjustments",
    "POST",
    adjustmentBody(product, -1, "Remove one serialized unit", idempotencyKey(), [
      { action: "REMOVE", serial: "SN-001" },
    ]),
  );
  assert.equal(removalResponse.status, 201, await removalResponse.clone().text());

  const removal = await removalResponse.json();
  assert.equal(removal.status, "PENDING");

  const removalApproval = await call(
    approver,
    `/api/v1/inventory/adjustments/${removal.id}/approve`,
    "POST",
    { tenantId, branchId, idempotencyKey: idempotencyKey() },
  );
  assert.equal(removalApproval.status, 201, await removalApproval.clone().text());

  const removedSerial = await migrator.query(
    `SELECT serial_normalized, status, removed_by_adjustment_id
     FROM inventory_serial_units
     WHERE tenant_id = $1 AND variant_id = $2
       AND serial_normalized = 'SN-001'`,
    [tenantId, product.variantId],
  );

  assert.equal(removedSerial.rows.length, 1);
  assert.equal(removedSerial.rows[0].status, "REMOVED");
  assert.equal(removedSerial.rows[0].removed_by_adjustment_id, removal.id);

  // A second adjustment cannot remove the same serial a second time.
  const duplicateRemovalResponse = await call(
    requester,
    "/api/v1/inventory/adjustments",
    "POST",
    adjustmentBody(product, -1, "Attempt duplicate serial removal", idempotencyKey(), [
      { action: "REMOVE", serial: "SN-001" },
    ]),
  );
  assert.equal(duplicateRemovalResponse.status, 201, await duplicateRemovalResponse.clone().text());

  const duplicateRemoval = await duplicateRemovalResponse.json();

  const duplicateApproval = await call(
    approver,
    `/api/v1/inventory/adjustments/${duplicateRemoval.id}/approve`,
    "POST",
    { tenantId, branchId, idempotencyKey: idempotencyKey() },
  );
  assert.equal(duplicateApproval.status, 409);

  const finalState = await migrator.query(
    `SELECT
       b.physical_quantity,
       s.status AS serial_status
     FROM inventory_balances b
     JOIN inventory_serial_units s
       ON s.tenant_id = b.tenant_id
      AND s.branch_id = b.branch_id
      AND s.variant_id = b.variant_id
     WHERE b.tenant_id = $1
       AND b.branch_id = $2
       AND b.variant_id = $3
       AND s.serial_normalized = 'SN-001'`,
    [tenantId, branchId, product.variantId],
  );

  assert.deepEqual(finalState.rows, [{ physical_quantity: 1, serial_status: "REMOVED" }]);
});

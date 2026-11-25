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
const users = [randomUUID(), randomUUID(), randomUUID()];
const tenantId = randomUUID();
const branchId = randomUUID();
const supplierId = randomUUID();
const productId = randomUUID();
const variantId = randomUUID();
const membershipIds = users.map(() => randomUUID());
const roleIds = users.map(() => randomUUID());
const cookieName = "__Host-serviceflow_session";
const inventoryTables = [
  "inventory_balances",
  "inventory_operations",
  "inventory_adjustments",
  "inventory_ledger_entries",
  "inventory_serial_units",
];

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
       VALUES ($1, 'M3 Purchase Order Test Tenant', $2, 'ACTIVE', NOW())`,
      [tenantId, `m3-po-${tenantId}`],
    );

    await migrator.query(
      `INSERT INTO branches (id, tenant_id, code, name, status, updated_at)
       VALUES ($1, $2, 'M3PO', 'M3 Purchase Order Branch', 'ACTIVE', NOW())`,
      [branchId, tenantId],
    );

    await migrator.query(
      `INSERT INTO suppliers
        (id, tenant_id, name, name_normalized, status, updated_at)
       VALUES ($1, $2, 'M3 PO Supplier', 'M3 PO SUPPLIER', 'ACTIVE', NOW())`,
      [supplierId, tenantId],
    );

    await migrator.query(
      `INSERT INTO products
        (id, tenant_id, product_code, name, product_kind, track_serials, status, updated_at)
       VALUES ($1, $2, 'M3-PO-PRODUCT', 'M3 PO Test Product', 'RETAIL', false, 'ACTIVE', NOW())`,
      [productId, tenantId],
    );

    await migrator.query(
      `INSERT INTO product_variants
        (id, tenant_id, product_id, variant_code, sku, name, attributes,
         is_default, status, updated_at)
       VALUES ($1, $2, $3, 'M3-PO-VARIANT', 'M3-PO-SKU',
               'M3 PO Test Variant', '{}'::jsonb, true, 'ACTIVE', NOW())`,
      [variantId, tenantId, productId],
    );

    for (let index = 0; index < users.length; index += 1) {
      const userId = users[index];
      const roleName = ["M3 PO Creator", "M3 PO Reviewer", "M3 PO Reader"][index];
      const templateCode = ["M3_PO_CREATOR", "M3_PO_REVIEWER", "M3_PO_READER"][index];

      await migrator.query(
        `INSERT INTO users
          (id, email_normalized, password_hash, display_name, email_verified_at, status, updated_at)
         VALUES ($1, $2, 'not-a-real-hash', $3, NOW(), 'ACTIVE', NOW())`,
        [userId, `${userId}@example.invalid`, roleName],
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
        [roleIds[index], tenantId, roleName, templateCode],
      );
    }

    await migrator.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
       VALUES
         ($1, $2, 'purchasing.read'),
         ($1, $2, 'purchasing.manage'),
         ($1, $3, 'purchasing.read'),
         ($1, $3, 'purchasing.manage'),
         ($1, $3, 'purchasing.approve'),
         ($1, $4, 'purchasing.read')`,
      [tenantId, roleIds[0], roleIds[1], roleIds[2]],
    );

    await migrator.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
       VALUES ($1, $2, $3), ($1, $4, $5), ($1, $6, $7)`,
      [
        tenantId,
        membershipIds[0],
        roleIds[0],
        membershipIds[1],
        roleIds[1],
        membershipIds[2],
        roleIds[2],
      ],
    );

    await migrator.query(
      `INSERT INTO membership_branch_scopes
        (id, tenant_id, membership_id, scope_type, branch_id, can_view, can_operate)
       VALUES
         ($1, $2, $3, 'BRANCH', $4, true, true),
         ($5, $2, $6, 'BRANCH', $4, true, true),
         ($7, $2, $8, 'BRANCH', $4, true, false)`,
      [
        randomUUID(),
        tenantId,
        membershipIds[0],
        branchId,
        randomUUID(),
        membershipIds[1],
        randomUUID(),
        membershipIds[2],
      ],
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
    await migrator.query("ALTER TABLE purchase_order_cancellation_requests DISABLE TRIGGER USER");
    await migrator.query("ALTER TABLE purchase_order_lines DISABLE TRIGGER USER");
    await migrator.query("ALTER TABLE purchase_orders DISABLE TRIGGER USER");
    await migrator.query("ALTER TABLE suppliers DISABLE TRIGGER USER");

    await migrator.query("DELETE FROM purchase_order_cancellation_requests WHERE tenant_id = $1", [
      tenantId,
    ]);
    await migrator.query("DELETE FROM purchase_order_lines WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM purchase_orders WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM purchase_order_counters WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM suppliers WHERE tenant_id = $1", [tenantId]);

    await migrator.query("ALTER TABLE purchase_order_cancellation_requests ENABLE TRIGGER USER");
    await migrator.query("ALTER TABLE purchase_order_lines ENABLE TRIGGER USER");
    await migrator.query("ALTER TABLE purchase_orders ENABLE TRIGGER USER");
    await migrator.query("ALTER TABLE suppliers ENABLE TRIGGER USER");

    await migrator.query("DELETE FROM product_variants WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]);

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
    await migrator.query("DELETE FROM branches WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM businesses WHERE id = $1", [tenantId]);
    await migrator.query("DELETE FROM auth_sessions WHERE user_id = ANY($1::uuid[])", [users]);
    await migrator.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [users]);

    await migrator.query("COMMIT");
  } catch (error) {
    await migrator.query("ROLLBACK");
    throw error;
  }
}

async function inventorySnapshot() {
  const snapshot = {};
  for (const table of inventoryTables) {
    const result = await migrator.query(
      `SELECT
         count(*)::int AS count,
         md5(coalesce(string_agg(to_jsonb(row_data)::text, E'\\n'
                                 ORDER BY to_jsonb(row_data)::text), '')) AS digest
       FROM ${table} AS row_data
       WHERE tenant_id = $1`,
      [tenantId],
    );
    snapshot[table] = result.rows[0];
  }
  return snapshot;
}

async function createOrder(session, notes = "M3.2 lifecycle test") {
  const response = await call(session, "/api/v1/purchase-orders", "POST", {
    tenantId,
    branchId,
    supplierId,
    notes,
  });
  assert.equal(response.status, 201, await response.clone().text());
  const order = await response.json();
  assert.equal(order.status, "DRAFT");
  assert.equal(order.currency, "BDT");
  assert.match(order.orderNumber, /^PO-\d{6}$/);
  return order;
}

async function getOrder(session, orderId) {
  const response = await call(session, `/api/v1/purchase-orders/${tenantId}?branchId=${branchId}`);
  assert.equal(response.status, 200, await response.clone().text());
  const result = await response.json();
  const order = result.purchaseOrders.find((item) => item.id === orderId);
  assert.ok(order, `Purchase order ${orderId} should be present in the list`);
  return order;
}

async function addLine(session, order, quantity = 5) {
  const response = await call(session, "/api/v1/purchase-orders/lines", "POST", {
    tenantId,
    branchId,
    purchaseOrderId: order.id,
    version: Number(order.version),
    productId,
    variantId,
    orderedQuantity: quantity,
    unitCostMinor: "12500",
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

async function lifecycle(session, endpoint, order, reason) {
  const body = {
    tenantId,
    branchId,
    purchaseOrderId: order.id,
    version: Number(order.version),
    ...(reason === undefined ? {} : { reason }),
  };
  return call(session, `/api/v1/purchase-orders/${endpoint}`, "POST", body);
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

  migrator = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();

  const migrationIdentity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(migrationIdentity.rows[0].role, "serviceflow_migrator");
  assert.equal(migrationIdentity.rows[0].database, expectedTestDatabase);

  runtime = new Client({ connectionString: process.env.DATABASE_URL });
  await runtime.connect();

  const runtimeIdentity = await runtime.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(runtimeIdentity.rows[0].role, "serviceflow_app");
  assert.equal(runtimeIdentity.rows[0].database, expectedTestDatabase);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  app.enableCors({
    origin: (requestOrigin, callback) => callback(null, requestOrigin === origin),
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

test("Purchase orders enforce draft editing, immutable submission, independent approval and cancellation lifecycle", async () => {
  const creator = await createSession(users[0]);
  const reviewer = await createSession(users[1]);
  const reader = await createSession(users[2]);
  const initialInventory = await inventorySnapshot();

  const emptyList = await call(creator, `/api/v1/purchase-orders/${tenantId}?branchId=${branchId}`);
  assert.equal(emptyList.status, 200);
  assert.deepEqual((await emptyList.json()).purchaseOrders, []);

  const readerCreate = await call(reader, "/api/v1/purchase-orders", "POST", {
    tenantId,
    branchId,
    supplierId,
  });
  assert.equal(readerCreate.status, 403);

  const crossTenant = await call(
    creator,
    `/api/v1/purchase-orders/${randomUUID()}?branchId=${branchId}`,
  );
  assert.equal(crossTenant.status, 403);

  const order = await createOrder(creator);
  assert.equal(order.version, "1");

  const firstLine = await addLine(creator, order, 5);
  assert.equal(firstLine.productCodeSnapshot, "M3-PO-PRODUCT");
  assert.equal(firstLine.productNameSnapshot, "M3 PO Test Product");
  assert.equal(firstLine.variantCodeSnapshot, "M3-PO-VARIANT");
  assert.equal(firstLine.skuSnapshot, "M3-PO-SKU");
  assert.equal(firstLine.unitCostMinor, "12500");

  let current = await getOrder(creator, order.id);
  assert.equal(current.version, "2");

  const lineListResponse = await call(
    creator,
    `/api/v1/purchase-orders/${tenantId}/${branchId}/${order.id}/lines`,
  );
  assert.equal(lineListResponse.status, 200);
  const lineList = await lineListResponse.json();
  assert.equal(lineList.lines.length, 1);
  assert.equal(lineList.lines[0].id, firstLine.id);

  const secondLineResponse = await call(creator, "/api/v1/purchase-orders/lines", "POST", {
    tenantId,
    branchId,
    purchaseOrderId: order.id,
    version: Number(current.version),
    productId,
    variantId,
    orderedQuantity: 2,
    unitCostMinor: "13000",
  });
  assert.equal(secondLineResponse.status, 201, await secondLineResponse.clone().text());

  current = await getOrder(creator, order.id);
  assert.equal(current.version, "3");

  const staleEdit = await call(creator, "/api/v1/purchase-orders/lines", "PATCH", {
    tenantId,
    branchId,
    purchaseOrderId: order.id,
    lineId: firstLine.id,
    version: 2,
    orderedQuantity: 9,
    unitCostMinor: "12500",
  });
  assert.equal(staleEdit.status, 409);

  const editLine = await call(creator, "/api/v1/purchase-orders/lines", "PATCH", {
    tenantId,
    branchId,
    purchaseOrderId: order.id,
    lineId: firstLine.id,
    version: Number(current.version),
    orderedQuantity: 7,
    unitCostMinor: "12750",
  });
  assert.equal(editLine.status, 200, await editLine.clone().text());

  current = await getOrder(creator, order.id);
  assert.equal(current.version, "4");

  const submitEmpty = await createOrder(creator, "Empty order must not submit");
  const emptySubmit = await lifecycle(creator, "submit", submitEmpty);
  assert.equal(emptySubmit.status, 409);

  const submitResponse = await lifecycle(creator, "submit", current);
  assert.equal(submitResponse.status, 201, await submitResponse.clone().text());
  const submitted = await submitResponse.json();
  assert.equal(submitted.status, "PENDING_APPROVAL");
  assert.equal(submitted.version, "5");

  const frozenEdit = await call(creator, "/api/v1/purchase-orders/lines", "PATCH", {
    tenantId,
    branchId,
    purchaseOrderId: order.id,
    lineId: firstLine.id,
    version: 5,
    orderedQuantity: 10,
    unitCostMinor: "12500",
  });
  assert.notEqual(frozenEdit.status, 200);
  assert.notEqual(frozenEdit.status, 201);

  const creatorApproval = await lifecycle(creator, "approve", submitted);
  assert.equal(creatorApproval.status, 403);

  const reviewerApproval = await lifecycle(reviewer, "approve", submitted);
  assert.equal(reviewerApproval.status, 201, await reviewerApproval.clone().text());
  const approved = await reviewerApproval.json();
  assert.equal(approved.status, "APPROVED");
  assert.equal(approved.version, "6");

  const nonCreatorRequest = await lifecycle(
    reviewer,
    "request-cancellation",
    approved,
    "Not creator",
  );
  assert.equal(nonCreatorRequest.status, 403);

  const requestResponse = await lifecycle(
    creator,
    "request-cancellation",
    approved,
    "Supplier delivery is no longer required",
  );
  assert.equal(requestResponse.status, 201, await requestResponse.clone().text());
  const request = await requestResponse.json();
  assert.equal(request.status, "PENDING");
  assert.equal(request.version, "1");

  const duplicateRequest = await lifecycle(
    creator,
    "request-cancellation",
    approved,
    "Duplicate pending request",
  );
  assert.equal(duplicateRequest.status, 409);

  const selfDecision = await call(creator, "/api/v1/purchase-orders/decide-cancellation", "POST", {
    tenantId,
    branchId,
    purchaseOrderId: order.id,
    version: 6,
    cancellationRequestId: request.id,
    requestVersion: 1,
    decision: "REJECTED",
    reason: "Self-review must fail",
  });
  assert.equal(selfDecision.status, 403);

  const rejectWithoutReason = await call(
    reviewer,
    "/api/v1/purchase-orders/decide-cancellation",
    "POST",
    {
      tenantId,
      branchId,
      purchaseOrderId: order.id,
      version: 6,
      cancellationRequestId: request.id,
      requestVersion: 1,
      decision: "REJECTED",
    },
  );
  assert.equal(rejectWithoutReason.status, 400);

  const rejection = await call(reviewer, "/api/v1/purchase-orders/decide-cancellation", "POST", {
    tenantId,
    branchId,
    purchaseOrderId: order.id,
    version: 6,
    cancellationRequestId: request.id,
    requestVersion: 1,
    decision: "REJECTED",
    reason: "Supplier confirmed the shipment is still required",
  });
  assert.equal(rejection.status, 201, await rejection.clone().text());
  const rejected = await rejection.json();
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.purchaseOrderStatus, "APPROVED");

  const afterRejection = await getOrder(creator, order.id);
  assert.equal(afterRejection.status, "APPROVED");
  assert.equal(afterRejection.version, "6");

  const secondRequestResponse = await lifecycle(
    creator,
    "request-cancellation",
    afterRejection,
    "Requirements changed again",
  );
  assert.equal(secondRequestResponse.status, 201, await secondRequestResponse.clone().text());
  const secondRequest = await secondRequestResponse.json();

  const finalDecision = await call(
    reviewer,
    "/api/v1/purchase-orders/decide-cancellation",
    "POST",
    {
      tenantId,
      branchId,
      purchaseOrderId: order.id,
      version: 6,
      cancellationRequestId: secondRequest.id,
      requestVersion: 1,
      decision: "APPROVED",
    },
  );
  assert.equal(finalDecision.status, 201, await finalDecision.clone().text());
  const cancelled = await finalDecision.json();
  assert.equal(cancelled.status, "APPROVED");
  assert.equal(cancelled.purchaseOrderStatus, "CANCELLED");

  const cancelledOrder = await getOrder(creator, order.id);
  assert.equal(cancelledOrder.status, "CANCELLED");
  assert.equal(cancelledOrder.version, "7");

  const draftToCancel = await createOrder(creator, "Draft cancellation test");
  const draftCancellation = await lifecycle(
    creator,
    "cancel-draft",
    draftToCancel,
    "Draft is no longer needed",
  );
  assert.equal(draftCancellation.status, 201, await draftCancellation.clone().text());
  assert.equal((await draftCancellation.json()).status, "CANCELLED");

  const pendingToWithdraw = await createOrder(creator, "Pending withdrawal test");
  await addLine(creator, pendingToWithdraw, 1);
  current = await getOrder(creator, pendingToWithdraw.id);

  const pendingResponse = await lifecycle(creator, "submit", current);
  assert.equal(pendingResponse.status, 201, await pendingResponse.clone().text());
  const pending = await pendingResponse.json();

  const withdrawResponse = await lifecycle(
    creator,
    "withdraw",
    pending,
    "Revising the purchasing requirement",
  );
  assert.equal(withdrawResponse.status, 201, await withdrawResponse.clone().text());
  const withdrawn = await withdrawResponse.json();
  assert.equal(withdrawn.status, "WITHDRAWN");

  const withdrawnOrder = await getOrder(creator, pendingToWithdraw.id);
  assert.equal(withdrawnOrder.status, "WITHDRAWN");
  assert.equal(withdrawnOrder.submittedByUserId, users[0]);
  assert.ok(withdrawnOrder.submittedAt);
  assert.equal(withdrawnOrder.withdrawnByUserId, users[0]);
  assert.equal(withdrawnOrder.withdrawalReason, "Revising the purchasing requirement");

  const audit = await migrator.query(
    `SELECT action
     FROM audit_events
     WHERE tenant_id = $1
       AND target_type IN ('purchase_order', 'purchase_order_cancellation_request')
     ORDER BY occurred_at, id`,
    [tenantId],
  );
  const actions = audit.rows.map((row) => row.action);
  for (const action of [
    "purchasing.purchase_order.created",
    "purchasing.purchase_order.submitted",
    "purchasing.purchase_order.approved",
    "purchasing.purchase_order.cancellation_requested",
    "purchasing.purchase_order.cancellation_rejected",
    "purchasing.purchase_order.cancellation_approved",
    "purchasing.purchase_order.draft_cancelled",
    "purchasing.purchase_order.withdrawn",
  ]) {
    assert.ok(actions.includes(action), `Expected audit action ${action}`);
  }

  assert.deepEqual(await inventorySnapshot(), initialInventory);
});

test("Purchase order mutations reject malformed UUIDs, missing CSRF, untrusted origins and unknown fields", async () => {
  const creator = await createSession(users[0]);

  const invalidTenant = await call(creator, "/api/v1/purchase-orders/not-a-uuid");
  assert.equal(invalidTenant.status, 400);

  const missingCsrf = await call(
    creator,
    "/api/v1/purchase-orders",
    "POST",
    { tenantId, branchId, supplierId },
    { includeCsrf: false },
  );
  assert.equal(missingCsrf.status, 403);

  const invalidCsrf = await call(
    creator,
    "/api/v1/purchase-orders",
    "POST",
    { tenantId, branchId, supplierId },
    { csrfToken: "invalid-csrf-token" },
  );
  assert.equal(invalidCsrf.status, 403);

  const untrustedOrigin = await call(
    creator,
    "/api/v1/purchase-orders",
    "POST",
    { tenantId, branchId, supplierId },
    { origin: "https://attacker.example.invalid" },
  );
  assert.equal(untrustedOrigin.status, 403);

  const unknownField = await call(creator, "/api/v1/purchase-orders", "POST", {
    tenantId,
    branchId,
    supplierId,
    isPlatformAdmin: true,
  });
  assert.equal(unknownField.status, 400);

  const persisted = await migrator.query(
    `SELECT count(*)::int AS count
     FROM purchase_orders
     WHERE tenant_id = $1
       AND notes IS NULL`,
    [tenantId],
  );
  assert.equal(persisted.rows[0].count, 0);
});

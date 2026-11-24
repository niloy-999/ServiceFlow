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
const users = [randomUUID(), randomUUID()];
const tenantId = randomUUID();
const membershipIds = [randomUUID(), randomUUID()];
const roleId = randomUUID();
const branchId = randomUUID();
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
       VALUES ($1, 'Catalogue Test Tenant', $2, 'ACTIVE', NOW())`,
      [tenantId, `catalogue-${tenantId}`],
    );
    for (let index = 0; index < users.length; index += 1) {
      const userId = users[index];
      const membershipId = membershipIds[index];
      await migrator.query(
        `INSERT INTO users (id, email_normalized, password_hash, display_name, email_verified_at, status, updated_at)
         VALUES ($1, $2, 'not-a-real-hash', 'Catalogue Test User', NOW(), 'ACTIVE', NOW())`,
        [userId, `${userId}@example.invalid`],
      );
      await migrator.query(
        `INSERT INTO tenant_memberships (id, tenant_id, user_id, status, joined_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', NOW(), NOW())`,
        [membershipId, tenantId, userId],
      );
    }
    await migrator.query(
      `INSERT INTO branches (id, tenant_id, code, name, updated_at)
       VALUES ($1, $2, 'CATALOGUE', 'Catalogue test branch', NOW())`,
      [branchId, tenantId],
    );
    await migrator.query(
      `INSERT INTO roles (id, tenant_id, name, is_system, status, template_code, updated_at)
       VALUES ($1, $2, 'Catalogue test role', false, 'ACTIVE', 'CATALOGUE_TEST', NOW())`,
      [roleId, tenantId],
    );
    await migrator.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
       VALUES ($1, $2, 'catalogue.read'), ($1, $2, 'catalogue.manage')`,
      [tenantId, roleId],
    );
    await migrator.query(
      `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
       VALUES ($1, $2, $3), ($1, $4, $3)`,
      [tenantId, membershipIds[0], roleId, membershipIds[1]],
    );
    await migrator.query(
      `INSERT INTO membership_branch_scopes
       (id, tenant_id, membership_id, scope_type, branch_id, can_view, can_operate)
       VALUES ($1, $2, $3, 'BUSINESS', NULL, true, true),
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
    await migrator.query(
      "ALTER TABLE product_prices DISABLE TRIGGER product_prices_history_immutable",
    );
    await migrator.query("DELETE FROM product_prices WHERE tenant_id = $1", [tenantId]);
    await migrator.query(
      "ALTER TABLE product_prices ENABLE TRIGGER product_prices_history_immutable",
    );
    await migrator.query("DELETE FROM product_identifiers WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM product_variants WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM products WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM categories WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM brands WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM membership_branch_scopes WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM membership_roles WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM role_permissions WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM roles WHERE tenant_id = $1", [tenantId]);
    await migrator.query("DELETE FROM branches WHERE tenant_id = $1", [tenantId]);
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
  migrator = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await migrator.connect();
  const identity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );
  assert.equal(identity.rows[0].role, "serviceflow_migrator");
  assert.equal(identity.rows[0].database, "serviceflow_test");
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

test("Catalogue CRUD keeps variant stock identity, pricing history, tenant isolation and audit", async () => {
  const owner = await createSession(users[0]);
  const unauthorized = await createSession(users[1]);
  const categoriesResponse = await call(owner, `/api/v1/catalogue/${tenantId}/categories`);
  assert.equal(categoriesResponse.status, 200);
  assert.deepEqual((await categoriesResponse.json()).categories, []);
  const readOnlyProducts = await call(unauthorized, `/api/v1/catalogue/${tenantId}/products`);
  assert.equal(readOnlyProducts.status, 200);

  const readOnlyMutation = await call(unauthorized, "/api/v1/catalogue/categories", "POST", {
    tenantId,
    name: "Should be denied",
  });
  assert.equal(readOnlyMutation.status, 403);

  const crossTenant = await call(owner, `/api/v1/catalogue/${randomUUID()}/products`);
  assert.equal(crossTenant.status, 403);

  const categoryResponse = await call(owner, "/api/v1/catalogue/categories", "POST", {
    tenantId,
    name: "Storage devices",
  });
  assert.equal(categoryResponse.status, 201);
  const category = await categoryResponse.json();
  const brandResponse = await call(owner, "/api/v1/catalogue/brands", "POST", {
    tenantId,
    name: "Example Brand",
  });
  assert.equal(brandResponse.status, 201);
  const brand = await brandResponse.json();
  const categoryUpdate = await call(
    owner,
    `/api/v1/catalogue/categories/${category.id}/update`,
    "POST",
    {
      tenantId,
      name: "Storage devices and media",
    },
  );
  assert.equal(categoryUpdate.status, 201);
  const brandUpdate = await call(owner, `/api/v1/catalogue/brands/${brand.id}/update`, "POST", {
    tenantId,
    name: "Example Brand International",
  });
  assert.equal(brandUpdate.status, 201);

  const productResponse = await call(owner, "/api/v1/catalogue/products", "POST", {
    tenantId,
    productCode: "SSD-FAMILY",
    name: "Portable SSD",
    description: "Portable SSD family",
    productKind: "BOTH",
    categoryId: category.id,
    brandId: brand.id,
    trackSerials: true,
    sku: "SSD-1TB-BLACK",
    priceMinor: 125000,
  });
  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();
  assert.equal(product.productKind, "BOTH");
  assert.equal(product.trackSerials, true);
  assert.equal(product.variants.length, 1);
  assert.equal(product.variants[0].isDefault, true);
  assert.equal(product.variants[0].sku, "SSD-1TB-BLACK");
  assert.equal(product.variants[0].priceMinor, "125000");
  const productId = product.id;
  const defaultVariantId = product.variants[0].id;

  const missingSku = await call(owner, "/api/v1/catalogue/products", "POST", {
    tenantId,
    productCode: "NO-SKU",
    name: "No SKU product",
    productKind: "RETAIL",
  });
  assert.equal(missingSku.status, 400);

  const duplicateSku = await call(owner, "/api/v1/catalogue/products", "POST", {
    tenantId,
    productCode: "OTHER-FAMILY",
    name: "Other Product",
    productKind: "RETAIL",
    sku: "ssd-1tb-black",
  });
  assert.equal(duplicateSku.status, 409);

  const updateResponse = await call(
    owner,
    `/api/v1/catalogue/products/${productId}/update`,
    "POST",
    {
      tenantId,
      version: Number(product.version),
      name: "Portable SSD Gen 2",
      productKind: "BOTH",
      trackSerials: true,
    },
  );
  assert.equal(updateResponse.status, 201);
  const updated = await updateResponse.json();
  assert.equal(updated.name, "Portable SSD Gen 2");
  assert.equal(updated.description, "Portable SSD family");
  assert.equal(updated.categoryId, category.id);
  assert.equal(updated.brandId, brand.id);
  assert.equal(updated.version, String(Number(product.version) + 1));
  const staleUpdate = await call(owner, `/api/v1/catalogue/products/${productId}/update`, "POST", {
    tenantId,
    version: Number(product.version),
    name: "Stale edit",
    productKind: "BOTH",
    categoryId: category.id,
    brandId: brand.id,
    trackSerials: true,
  });
  assert.equal(staleUpdate.status, 409);

  const variantUpdate = await call(
    owner,
    `/api/v1/catalogue/variants/${defaultVariantId}/update`,
    "POST",
    {
      tenantId,
      version: Number(product.variants[0].version),
      sku: "SSD-1TB-BLACK",
      name: "1 TB Black",
      attributes: { capacityGb: 1024, colour: "black" },
      priceMinor: 127500,
      currency: "bdt",
    },
  );
  assert.equal(variantUpdate.status, 201);
  const variantChanged = await variantUpdate.json();
  assert.equal(variantChanged.variants[0].priceMinor, "127500");

  const priceHistory = await migrator.query(
    "SELECT amount_minor::text AS amount, valid_to IS NOT NULL AS closed FROM product_prices WHERE tenant_id = $1 AND variant_id = $2 ORDER BY valid_from",
    [tenantId, defaultVariantId],
  );
  assert.deepEqual(priceHistory.rows, [
    { amount: "125000", closed: true },
    { amount: "127500", closed: false },
  ]);
  await assert.rejects(
    runtime.query(
      "UPDATE product_prices SET amount_minor = 1 WHERE tenant_id = $1 AND variant_id = $2",
      [tenantId, defaultVariantId],
    ),
    (error) => error.code === "42501",
  );

  const identifierProduct = await call(owner, "/api/v1/catalogue/products", "POST", {
    tenantId,
    productCode: "VARIANT-FAMILY",
    name: "Memory module",
    productKind: "REPAIR_PART",
    variants: [
      {
        variantCode: "DDR4-8GB",
        sku: "RAM-DDR4-8",
        name: "8 GB DDR4",
        isDefault: true,
        identifiers: [{ type: "BARCODE", value: " 1234567890 " }],
      },
      { variantCode: "DDR4-16GB", sku: "RAM-DDR4-16", name: "16 GB DDR4" },
    ],
  });
  assert.equal(identifierProduct.status, 201);
  const grouped = await identifierProduct.json();
  assert.equal(grouped.variants.length, 2);
  assert.equal(grouped.variants.filter((variant) => variant.isDefault).length, 1);
  const storedIdentifier = await migrator.query(
    "SELECT value_normalized FROM product_identifiers WHERE tenant_id = $1",
    [tenantId],
  );
  assert.equal(storedIdentifier.rows[0].value_normalized, "1234567890");
  const addedVariant = await call(
    owner,
    `/api/v1/catalogue/products/${grouped.id}/variants`,
    "POST",
    {
      tenantId,
      variantCode: "DDR5-16GB",
      sku: "RAM-DDR5-16",
      name: "16 GB DDR5",
      isDefault: false,
      attributes: { generation: "DDR5", capacityGb: 16 },
    },
  );
  assert.equal(addedVariant.status, 201);
  const withAddedVariant = await addedVariant.json();
  assert.equal(withAddedVariant.variants.length, 3);
  const newDefault = withAddedVariant.variants.find((variant) => variant.sku === "RAM-DDR5-16");
  const oldDefault = withAddedVariant.variants.find((variant) => variant.isDefault);
  assert.ok(newDefault && oldDefault);
  const defaultChange = await call(
    owner,
    `/api/v1/catalogue/variants/${newDefault.id}/default`,
    "POST",
    { tenantId },
  );
  assert.equal(defaultChange.status, 201);
  const defaultProduct = await defaultChange.json();
  assert.equal(defaultProduct.variants.filter((variant) => variant.isDefault).length, 1);
  assert.equal(defaultProduct.variants.find((variant) => variant.isDefault).sku, "RAM-DDR5-16");
  const archiveVariant = await call(
    owner,
    `/api/v1/catalogue/variants/${oldDefault.id}/archive`,
    "POST",
    { tenantId },
  );
  assert.equal(archiveVariant.status, 201);
  const refuseDefaultArchive = await call(
    owner,
    `/api/v1/catalogue/variants/${newDefault.id}/archive`,
    "POST",
    { tenantId },
  );
  assert.equal(refuseDefaultArchive.status, 409);

  const archivedCategory = await call(
    owner,
    `/api/v1/catalogue/categories/${category.id}/archive`,
    "POST",
    { tenantId },
  );
  assert.equal(archivedCategory.status, 201);
  const productAfterCategoryArchive = await call(
    owner,
    `/api/v1/catalogue/${tenantId}/products/${productId}`,
  );
  assert.equal(productAfterCategoryArchive.status, 200);
  const archiveBrand = await call(owner, `/api/v1/catalogue/brands/${brand.id}/archive`, "POST", {
    tenantId,
  });
  assert.equal(archiveBrand.status, 201);
  const archiveProduct = await call(
    owner,
    `/api/v1/catalogue/products/${productId}/archive`,
    "POST",
    { tenantId },
  );
  assert.equal(archiveProduct.status, 201);

  const audit = await migrator.query(
    "SELECT count(*)::int AS count FROM audit_events WHERE tenant_id = $1 AND action LIKE 'catalogue.%'",
    [tenantId],
  );
  assert.equal(audit.rows[0].count, 14);
});

test("Concurrent variant mutations preserve one active default and prevent archiving a default", async () => {
  const owner = await createSession(users[0]);

  const productResponse = await call(owner, "/api/v1/catalogue/products", "POST", {
    tenantId,
    productCode: "RACE-FAMILY",
    name: "Concurrency test product",
    productKind: "RETAIL",
    sku: "RACE-BASE",
  });

  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();
  const baseVariantId = product.variants[0].id;

  const firstResponse = await call(
    owner,
    `/api/v1/catalogue/products/${product.id}/variants`,
    "POST",
    {
      tenantId,
      variantCode: "RACE-A",
      sku: "RACE-A",
      name: "Race variant A",
      isDefault: false,
    },
  );
  assert.equal(firstResponse.status, 201);
  const firstVariant = (await firstResponse.json()).variants.find(
    (variant) => variant.sku === "RACE-A",
  );
  assert.ok(firstVariant);

  const secondResponse = await call(
    owner,
    `/api/v1/catalogue/products/${product.id}/variants`,
    "POST",
    {
      tenantId,
      variantCode: "RACE-B",
      sku: "RACE-B",
      name: "Race variant B",
      isDefault: false,
    },
  );
  assert.equal(secondResponse.status, 201);
  const secondVariant = (await secondResponse.json()).variants.find(
    (variant) => variant.sku === "RACE-B",
  );
  assert.ok(secondVariant);

  // Both requests contend for the same parent product lock.
  const defaultResults = await Promise.all([
    call(owner, `/api/v1/catalogue/variants/${firstVariant.id}/default`, "POST", {
      tenantId,
    }),
    call(owner, `/api/v1/catalogue/variants/${secondVariant.id}/default`, "POST", {
      tenantId,
    }),
  ]);

  assert.deepEqual(
    defaultResults.map((response) => response.status),
    [201, 201],
  );

  const defaultsAfterRace = await migrator.query(
    `SELECT id
     FROM product_variants
     WHERE tenant_id = $1 AND product_id = $2
       AND status = 'ACTIVE' AND is_default`,
    [tenantId, product.id],
  );

  assert.equal(defaultsAfterRace.rows.length, 1);
  assert.ok([firstVariant.id, secondVariant.id].includes(defaultsAfterRace.rows[0].id));

  // Race making a non-default variant default against archiving that same variant.
  const currentDefaultId = defaultsAfterRace.rows[0].id;
  const archiveTargetId = [baseVariantId, firstVariant.id, secondVariant.id].find(
    (id) => id !== currentDefaultId,
  );
  assert.ok(archiveTargetId);

  const [makeDefaultResult, archiveResult] = await Promise.all([
    call(owner, `/api/v1/catalogue/variants/${archiveTargetId}/default`, "POST", {
      tenantId,
    }),
    call(owner, `/api/v1/catalogue/variants/${archiveTargetId}/archive`, "POST", {
      tenantId,
    }),
  ]);

  const makeDefaultStatus = makeDefaultResult.status;
  const archiveStatus = archiveResult.status;

  assert.ok(
    (makeDefaultStatus === 201 && archiveStatus === 409) ||
      (makeDefaultStatus === 404 && archiveStatus === 201),
    `Unexpected race outcomes: make-default=${makeDefaultStatus}, archive=${archiveStatus}`,
  );

  const finalVariants = await migrator.query(
    `SELECT id, status, is_default
     FROM product_variants
     WHERE tenant_id = $1 AND product_id = $2`,
    [tenantId, product.id],
  );

  const activeDefaults = finalVariants.rows.filter(
    (variant) => variant.status === "ACTIVE" && variant.is_default,
  );

  assert.equal(activeDefaults.length, 1);

  const archivedTarget = finalVariants.rows.find((variant) => variant.id === archiveTargetId);

  if (archiveStatus === 201) {
    assert.equal(archivedTarget.status, "ARCHIVED");
    assert.equal(archivedTarget.is_default, false);
  } else {
    assert.equal(archivedTarget.status, "ACTIVE");
    assert.equal(archivedTarget.is_default, true);
  }
});

test("Catalogue DTOs reject unknown and malformed fields", async () => {
  const owner = await createSession(users[0]);
  const response = await call(owner, "/api/v1/catalogue/products", "POST", {
    tenantId,
    productCode: "INVALID",
    name: "Invalid product",
    productKind: "RETAIL",
    sku: "INVALID-1",
    unsupported: true,
  });
  assert.equal(response.status, 400);
});

test("PostgreSQL rejects a product committed without one active default variant", async () => {
  const productId = randomUUID();
  await migrator.query("BEGIN");
  await migrator.query(
    `INSERT INTO products
      (id, tenant_id, product_code, name, product_kind, status, updated_at)
     VALUES ($1, $2, $3, 'Unstockable fixture', 'RETAIL', 'ACTIVE', NOW())`,
    [productId, tenantId, `NO-DEFAULT-${productId}`],
  );
  await assert.rejects(migrator.query("COMMIT"), (error) => error.code === "23514");
  await migrator.query("ROLLBACK");
  const absent = await migrator.query("SELECT count(*)::int AS count FROM products WHERE id = $1", [
    productId,
  ]);
  assert.equal(absent.rows[0].count, 0);
});

import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";

import { AppModule } from "../dist/app.module.js";
import { PrismaService } from "../dist/database/prisma.service.js";
import { TenantContextService } from "../dist/database/tenant-context.service.js";
import { AuthorizationService } from "../dist/authorization/authorization.service.js";

const tenantA = randomUUID();
const tenantB = randomUUID();

const userA = randomUUID();
const userB = randomUUID();

const membershipA = randomUUID();
const membershipB = randomUUID();

const branchA = randomUUID();
const branchB = randomUUID();
const disposableBranchA = randomUUID();

const roleA = randomUUID();
const roleB = randomUUID();

const permissionCode = `test.rls_${randomUUID().replaceAll("-", "")}`;

const tenantIds = [tenantA, tenantB];

const tables = [
  "tenant_memberships",
  "branches",
  "roles",
  "role_permissions",
  "membership_roles",
  "membership_branch_scopes",
];

let app;
let tenantContext;
let authorization;
let prisma;
let migrator;
let fixturesCreated = false;

async function createFixtures() {
  const now = new Date();

  await migrator.query("BEGIN");

  try {
    for (const [id, name, slug] of [
      [tenantA, "RLS Integration Tenant A", `rls-${tenantA}`],
      [tenantB, "RLS Integration Tenant B", `rls-${tenantB}`],
    ]) {
      await migrator.query(
        `INSERT INTO businesses (id, name, slug, status, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', $4)`,
        [id, name, slug, now],
      );
    }

    for (const [id, email, name] of [
      [userA, `${userA}@example.invalid`, "RLS Integration User A"],
      [userB, `${userB}@example.invalid`, "RLS Integration User B"],
    ]) {
      await migrator.query(
        `INSERT INTO users
           (id, email_normalized, password_hash, display_name, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, email, "test-only-not-a-real-password-hash", name, now],
      );
    }

    for (const [id, tenantId, userId] of [
      [membershipA, tenantA, userA],
      [membershipB, tenantB, userB],
    ]) {
      await migrator.query(
        `INSERT INTO tenant_memberships
           (id, tenant_id, user_id, status, joined_at, updated_at)
         VALUES ($1, $2, $3, 'ACTIVE', $4, $4)`,
        [id, tenantId, userId, now],
      );
    }

    for (const [id, tenantId, code, name] of [
      [branchA, tenantA, "RLS-TEST-A", "RLS Integration Branch A"],
      [branchB, tenantB, "RLS-TEST-B", "RLS Integration Branch B"],
    ]) {
      await migrator.query(
        `INSERT INTO branches (id, tenant_id, code, name, updated_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, tenantId, code, name, now],
      );
    }

    for (const [id, tenantId, name] of [
      [roleA, tenantA, "RLS Integration Role A"],
      [roleB, tenantB, "RLS Integration Role B"],
    ]) {
      await migrator.query(
        `INSERT INTO roles (id, tenant_id, name, updated_at)
         VALUES ($1, $2, $3, $4)`,
        [id, tenantId, name, now],
      );
    }

    await migrator.query(
      `INSERT INTO permissions (code, description, risk_class)
       VALUES ($1, $2, $3)`,
      [permissionCode, "Temporary RLS integration permission", "LOW"],
    );

    for (const [tenantId, roleId] of [
      [tenantA, roleA],
      [tenantB, roleB],
    ]) {
      await migrator.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
         VALUES ($1, $2, $3)`,
        [tenantId, roleId, permissionCode],
      );
    }

    for (const [tenantId, membershipId, roleId] of [
      [tenantA, membershipA, roleA],
      [tenantB, membershipB, roleB],
    ]) {
      await migrator.query(
        `INSERT INTO membership_roles (tenant_id, membership_id, role_id)
         VALUES ($1, $2, $3)`,
        [tenantId, membershipId, roleId],
      );
      await migrator.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
         VALUES ($1, $2, 'catalogue.read')`,
        [tenantId, roleId],
      );
      const selectedBranch = tenantId === tenantA ? branchA : branchB;
      await migrator.query(
        `INSERT INTO membership_branch_scopes
         (id, tenant_id, membership_id, scope_type, branch_id, can_view, can_operate)
         VALUES ($1, $2, $3, 'BRANCH', $4, true, false)`,
        [randomUUID(), tenantId, membershipId, selectedBranch],
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
    await migrator.query(`DELETE FROM membership_branch_scopes WHERE tenant_id = ANY($1::uuid[])`, [
      tenantIds,
    ]);
    await migrator.query(`DELETE FROM membership_roles WHERE tenant_id = ANY($1::uuid[])`, [
      tenantIds,
    ]);

    await migrator.query(`DELETE FROM role_permissions WHERE tenant_id = ANY($1::uuid[])`, [
      tenantIds,
    ]);

    await migrator.query(`DELETE FROM tenant_memberships WHERE tenant_id = ANY($1::uuid[])`, [
      tenantIds,
    ]);

    await migrator.query(`DELETE FROM branches WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);

    await migrator.query(`DELETE FROM roles WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);

    await migrator.query(`DELETE FROM permissions WHERE code = $1`, [permissionCode]);

    await migrator.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);

    await migrator.query(`DELETE FROM businesses WHERE id = ANY($1::uuid[])`, [tenantIds]);

    await migrator.query("COMMIT");
  } catch (error) {
    await migrator.query("ROLLBACK");
    throw error;
  }
}

before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required");
  assert.ok(process.env.MIGRATION_DATABASE_URL, "MIGRATION_DATABASE_URL is required");

  migrator = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
  });

  await migrator.connect();

  const migrationIdentity = await migrator.query(
    "SELECT current_user AS role, current_database() AS database",
  );

  assert.equal(migrationIdentity.rows[0].role, "serviceflow_migrator");
  assert.equal(migrationIdentity.rows[0].database, "serviceflow_test");
  const migrationTimezone = await migrator.query("SELECT current_setting('TimeZone') AS timezone");
  assert.equal(migrationTimezone.rows[0].timezone, "UTC");

  app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  tenantContext = app.get(TenantContextService);
  authorization = app.get(AuthorizationService);
  prisma = app.get(PrismaService);

  const appIdentity = await prisma.$queryRaw`
    SELECT current_user AS role, current_database() AS database,
      current_setting('TimeZone') AS timezone
  `;

  assert.equal(appIdentity[0].role, "serviceflow_app");
  assert.equal(appIdentity[0].database, "serviceflow_test");
  assert.equal(appIdentity[0].timezone, "UTC");

  await createFixtures();
  fixturesCreated = true;
});

after(async () => {
  try {
    if (migrator && fixturesCreated) {
      await cleanupFixtures();
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

test("Tenant access requires an active user, membership, and business", async () => {
  const discovery = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('app.user_id', ${userA}, true)
    `;

    const beforeTenant = await tx.$queryRaw`
      SELECT id, tenant_id
      FROM tenant_memberships
      ORDER BY id
    `;

    await tx.$queryRaw`
      SELECT set_config('app.tenant_id', ${tenantA}, true)
    `;

    const afterTenant = await tx.$queryRaw`
      SELECT id, tenant_id
      FROM tenant_memberships
      ORDER BY id
    `;

    return { beforeTenant, afterTenant };
  });

  assert.deepEqual(
    discovery.beforeTenant.map((row) => row.id),
    [membershipA],
    "User must discover their own membership before tenant selection",
  );

  assert.deepEqual(
    discovery.afterTenant.map((row) => row.id),
    [membershipA],
    "Tenant context must restrict membership visibility",
  );

  async function assertDenied(userId, tenantId, message) {
    let callbackInvoked = false;

    await assert.rejects(
      tenantContext.withAuthorizedTenantContext(userId, tenantId, async () => {
        callbackInvoked = true;
      }),
      (error) => error?.getStatus?.() === 403,
      message,
    );

    assert.equal(callbackInvoked, false, `${message}: callback must not execute`);
  }

  await assertDenied(userA, tenantB, "A user cannot access another user's business");

  try {
    await migrator.query("UPDATE tenant_memberships SET status = 'INVITED' WHERE id = $1", [
      membershipA,
    ]);
    await assertDenied(userA, tenantA, "Invited membership must be denied");
  } finally {
    await migrator.query("UPDATE tenant_memberships SET status = 'ACTIVE' WHERE id = $1", [
      membershipA,
    ]);
  }

  try {
    await migrator.query("UPDATE tenant_memberships SET left_at = NOW() WHERE id = $1", [
      membershipA,
    ]);
    await assertDenied(userA, tenantA, "Departed membership must be denied");
  } finally {
    await migrator.query("UPDATE tenant_memberships SET left_at = NULL WHERE id = $1", [
      membershipA,
    ]);
  }

  try {
    await migrator.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [userA]);
    await assertDenied(userA, tenantA, "Inactive user must be denied");
  } finally {
    await migrator.query("UPDATE users SET status = 'ACTIVE' WHERE id = $1", [userA]);
  }

  try {
    await migrator.query("UPDATE businesses SET status = 'SUSPENDED' WHERE id = $1", [tenantA]);
    await assertDenied(userA, tenantA, "Suspended business must be denied");
  } finally {
    await migrator.query("UPDATE businesses SET status = 'ACTIVE' WHERE id = $1", [tenantA]);
  }
});

test("Authorization helper rejects identities that differ from the active transaction context", async () => {
  await tenantContext.withAuthorizedTenantContext(userA, tenantA, async (tx) => {
    await assert.rejects(
      authorization.assertPermissionInTransaction(tx, {
        userId: userB,
        tenantId: tenantA,
        branchId: branchA,
        permission: "catalogue.read",
        operation: "VIEW",
      }),
      (error) => error?.getStatus?.() === 403,
      "A different user must be rejected",
    );

    await assert.rejects(
      authorization.assertPermissionInTransaction(tx, {
        userId: userA,
        tenantId: tenantB,
        branchId: branchB,
        permission: "catalogue.read",
        operation: "VIEW",
      }),
      (error) => error?.getStatus?.() === 403,
      "A different tenant must be rejected",
    );
  });
});

test("Permissions and branch scopes are independently enforced in the tenant transaction", async () => {
  await assert.rejects(
    migrator.query(
      `INSERT INTO membership_branch_scopes
       (id, tenant_id, membership_id, scope_type, branch_id, can_view, can_operate)
       VALUES ($1, $2, $3, 'BRANCH', $4, true, true)`,
      [randomUUID(), tenantA, membershipA, branchB],
    ),
    (error) => error.code === "23503",
    "A tenant scope cannot refer to a branch from another tenant",
  );
  const visible = await authorization.withPermission({
    userId: userA,
    tenantId: tenantA,
    branchId: branchA,
    permission: "catalogue.read",
    operation: "VIEW",
    callback: async () => "visible",
  });
  assert.equal(visible, "visible");
  await assert.rejects(
    authorization.withPermission({
      userId: userA,
      tenantId: tenantA,
      branchId: branchA,
      permission: "catalogue.read",
      operation: "OPERATE",
      callback: async () => "must not run",
    }),
  );
  await assert.rejects(
    authorization.withPermission({
      userId: userA,
      tenantId: tenantA,
      branchId: branchB,
      permission: "catalogue.read",
      callback: async () => "must not run",
    }),
  );
  await assert.rejects(
    authorization.withPermission({
      userId: userA,
      tenantId: tenantA,
      permission: "catalogue.read",
      callback: async () => "must not run",
    }),
  );
  await assert.rejects(
    authorization.withPermission({
      userId: userA,
      tenantId: tenantB,
      branchId: branchB,
      permission: "catalogue.read",
      callback: async () => "must not run",
    }),
  );
});

test("PostgreSQL enforces tenant isolation across concurrent transactions", async () => {
  const noContextCounts = await prisma.$transaction(async (tx) => {
    const counts = {};

    for (const table of tables) {
      const rows = await tx.$queryRawUnsafe(`SELECT count(*)::int AS total FROM "${table}"`);

      counts[table] = rows[0].total;
    }

    return counts;
  });

  for (const table of tables) {
    assert.equal(noContextCounts[table], 0, `${table} must deny access without context`);
  }

  for (const [tenantId, otherTenantId] of [
    [tenantA, tenantB],
    [tenantB, tenantA],
  ]) {
    await tenantContext.withAuthorizedTenantContext(
      tenantId === tenantA ? userA : userB,
      tenantId,
      async (tx) => {
        for (const table of tables) {
          const own = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS total FROM "${table}" WHERE tenant_id = $1::uuid`,
            tenantId,
          );

          const foreign = await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS total FROM "${table}" WHERE tenant_id = $1::uuid`,
            otherTenantId,
          );

          const expectedOwnRows = table === "role_permissions" ? 2 : 1;
          assert.equal(own[0].total, expectedOwnRows, `${table}: own tenant rows must be visible`);
          assert.equal(foreign[0].total, 0, `${table}: foreign tenant row must be hidden`);
        }
      },
    );
  }

  await migrator.query(
    `INSERT INTO branches (id, tenant_id, code, name, updated_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [disposableBranchA, tenantA, "RLS-DELETE-A", "Disposable RLS Branch A"],
  );

  const rlsViolation = (error) =>
    error.code === "P2010" &&
    error.message.includes("Code: `42501`") &&
    error.message.includes("row-level security policy");

  await tenantContext.withAuthorizedTenantContext(userA, tenantA, async (tx) => {
    const updateForeign = await tx.$executeRaw`
      UPDATE branches SET name = 'UNAUTHORIZED'
      WHERE id = ${branchB}::uuid
    `;

    const deleteForeign = await tx.$executeRaw`
      DELETE FROM branches WHERE id = ${branchB}::uuid
    `;

    assert.equal(updateForeign, 0, "Cross-tenant update must affect zero rows");
    assert.equal(deleteForeign, 0, "Cross-tenant delete must affect zero rows");
  });

  await assert.rejects(
    tenantContext.withAuthorizedTenantContext(
      userA,
      tenantA,
      (tx) => tx.$executeRaw`
      INSERT INTO branches (id, tenant_id, code, name, updated_at)
      VALUES (
        ${randomUUID()}::uuid,
        ${tenantB}::uuid,
        'RLS-UNAUTHORIZED',
        'Unauthorized branch',
        NOW()
      )
    `,
    ),
    rlsViolation,
  );

  await assert.rejects(
    tenantContext.withAuthorizedTenantContext(
      userA,
      tenantA,
      (tx) => tx.$executeRaw`
      UPDATE branches
      SET tenant_id = ${tenantB}::uuid
      WHERE id = ${branchA}::uuid
    `,
    ),
    rlsViolation,
  );

  await tenantContext.withAuthorizedTenantContext(userA, tenantA, async (tx) => {
    const ownUpdate = await tx.$executeRaw`
      UPDATE branches
      SET name = 'RLS Integration Branch A Updated'
      WHERE id = ${branchA}::uuid
    `;

    assert.equal(ownUpdate, 1, "Same-tenant update must succeed");
  });

  await tenantContext.withAuthorizedTenantContext(userA, tenantA, async (tx) => {
    const ownDelete = await tx.$executeRaw`
      DELETE FROM branches WHERE id = ${disposableBranchA}::uuid
    `;

    assert.equal(ownDelete, 1, "Same-tenant delete must succeed");
  });

  const concurrentResults = await Promise.all([
    tenantContext.withAuthorizedTenantContext(userA, tenantA, async (tx) => {
      for (let i = 0; i < 20; i += 1) {
        const rows = await tx.$queryRaw`
          SELECT current_setting('app.tenant_id', true) AS tenant_id,
                 code
          FROM branches
        `;

        assert.equal(rows[0].tenant_id, tenantA);
        assert.deepEqual(
          rows.map((row) => row.code),
          ["RLS-TEST-A"],
        );
      }

      return 20;
    }),
    tenantContext.withAuthorizedTenantContext(userB, tenantB, async (tx) => {
      for (let i = 0; i < 20; i += 1) {
        const rows = await tx.$queryRaw`
          SELECT current_setting('app.tenant_id', true) AS tenant_id,
                 code
          FROM branches
        `;

        assert.equal(rows[0].tenant_id, tenantB);
        assert.deepEqual(
          rows.map((row) => row.code),
          ["RLS-TEST-B"],
        );
      }

      return 20;
    }),
  ]);

  assert.deepEqual(concurrentResults, [20, 20]);

  const outsideContext = await prisma.$queryRaw`
    SELECT
      current_setting('app.user_id', true) AS user_id,
      current_setting('app.tenant_id', true) AS tenant_id
  `;

  for (const [key, value] of Object.entries(outsideContext[0])) {
    assert.ok(value == null || value === "", `${key} must not persist outside its transaction`);
  }
});

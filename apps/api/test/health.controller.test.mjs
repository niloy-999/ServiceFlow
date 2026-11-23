import assert from "node:assert/strict";
import test from "node:test";
import { HealthController } from "../dist/health/health.controller.js";

test("liveness does not depend on the database", () => {
  let queries = 0;
  const controller = new HealthController({ $queryRaw: async () => queries++ });
  assert.deepEqual(controller.live(), { status: "ok", service: "serviceflow-api" });
  assert.equal(queries, 0);
});

test("readiness and the legacy health route verify database connectivity", async () => {
  let queries = 0;
  const controller = new HealthController({ $queryRaw: async () => queries++ });
  assert.deepEqual(await controller.ready(), {
    status: "ok",
    service: "serviceflow-api",
    database: "ok",
  });
  assert.deepEqual(await controller.check(), {
    status: "ok",
    service: "serviceflow-api",
    database: "ok",
  });
  assert.equal(queries, 2);
});

import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments } from "../scripts/rotate-mfa-encryption-keys.mjs";

test("defaults to dry-run with an explicit database", () => {
  assert.deepEqual(parseArguments(["--database", "serviceflow_dev"]), {
    mode: "dry-run",
    expectedDatabase: "serviceflow_dev",
  });
});

test("accepts pnpm argument separator", () => {
  assert.deepEqual(parseArguments(["--", "--database", "serviceflow_dev"]), {
    mode: "dry-run",
    expectedDatabase: "serviceflow_dev",
  });
});

test("accepts apply mode", () => {
  assert.deepEqual(parseArguments(["--apply", "--database", "serviceflow_dev"]), {
    mode: "apply",
    expectedDatabase: "serviceflow_dev",
  });
});

test("accepts verify mode", () => {
  assert.deepEqual(parseArguments(["--verify", "--database", "serviceflow_dev"]), {
    mode: "verify",
    expectedDatabase: "serviceflow_dev",
  });
});

test("requires an explicit database", () => {
  assert.throws(() => parseArguments([]), /--database is required/);
});

test("rejects a missing database value", () => {
  assert.throws(() => parseArguments(["--database"]), /requires an expected database name/);
});

test("rejects duplicate database arguments", () => {
  assert.throws(
    () => parseArguments(["--database", "serviceflow_dev", "--database", "another_db"]),
    /may only be supplied once/,
  );
});

test("rejects conflicting execution modes", () => {
  assert.throws(
    () => parseArguments(["--apply", "--verify", "--database", "serviceflow_dev"]),
    /Choose only one execution mode/,
  );
});

test("rejects repeated execution modes", () => {
  assert.throws(
    () => parseArguments(["--apply", "--apply", "--database", "serviceflow_dev"]),
    /Choose only one execution mode/,
  );
});

test("rejects invalid database names", () => {
  for (const database of ["serviceflow/dev", "database name", "db;DROP", "a".repeat(64)]) {
    assert.throws(() => parseArguments(["--database", database]), /Invalid expected database name/);
  }
});

test("rejects unknown command-line arguments", () => {
  assert.throws(
    () => parseArguments(["--unknown", "--database", "serviceflow_dev"]),
    /Unknown command-line argument/,
  );
});

test("module import does not execute the maintenance utility", () => {
  assert.equal(typeof parseArguments, "function");
});

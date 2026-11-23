import assert from "node:assert/strict";
import test from "node:test";

import { createApiLogger, getApiListenConfig } from "../dist/config/runtime-config.js";

test("uses a loopback-safe host and the default API port", () => {
  assert.deepEqual(getApiListenConfig({}), { host: "127.0.0.1", port: 3001 });
});

test("accepts an explicit container host and valid port", () => {
  assert.deepEqual(getApiListenConfig({ API_HOST: "0.0.0.0", PORT: "8080" }), {
    host: "0.0.0.0",
    port: 8080,
  });
});

test("rejects empty, whitespace, or oversized hosts", () => {
  for (const API_HOST of ["", "  ", "bad host", "x".repeat(254)]) {
    assert.throws(() => getApiListenConfig({ API_HOST }), /API_HOST/);
  }
});

test("rejects non-integer or out-of-range ports", () => {
  for (const PORT of ["", "0", "65536", "3.14", "3000x", "-1"]) {
    assert.throws(() => getApiListenConfig({ PORT }), /PORT/);
  }
});

test("API logger emits JSON and redacts sensitive structured fields", () => {
  const logger = createApiLogger();
  let output = "";
  const originalWrite = process.stdout.write;

  process.stdout.write = (...args) => {
    output += String(args[0]);
    const callback = args.find((argument) => typeof argument === "function");
    callback?.();
    return true;
  };

  try {
    logger.log(
      {
        event: "redaction_probe",
        password: "fake-password-value",
        safe: "visible",
        token: "fake-token-value",
      },
      "runtime-config-test",
    );
  } finally {
    process.stdout.write = originalWrite;
  }

  const record = JSON.parse(output);
  assert.equal(record.message.password, "[REDACTED]");
  assert.equal(record.message.token, "[REDACTED]");
  assert.equal(record.message.safe, "visible");
});

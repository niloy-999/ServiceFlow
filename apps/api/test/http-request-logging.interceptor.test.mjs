import assert from "node:assert/strict";
import test from "node:test";
import { of, throwError } from "rxjs";
import { HttpRequestLoggingInterceptor } from "../dist/observability/http-request-logging.interceptor.js";

function fixture(url = "/account?token=must-not-appear") {
  const logs = [];
  const req = {
    method: "GET",
    originalUrl: url,
    baseUrl: "/api/v1",
    route: { path: url.startsWith("/reset") ? "/reset" : "/account" },
  };
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      this[name] = value;
    },
  };
  const logger = { log: (entry) => logs.push(entry), error: (entry) => logs.push(entry) };
  const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
  const interceptor = new HttpRequestLoggingInterceptor(logger);
  return { logs, req, res, context, interceptor };
}

test("correlates request and response and omits query secrets from access logs", async () => {
  const f = fixture();
  await new Promise((resolve, reject) =>
    f.interceptor
      .intercept(f.context, { handle: () => of("ok") })
      .subscribe({ complete: resolve, error: reject }),
  );
  assert.match(f.req.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(f.res["X-Request-Id"], f.req.requestId);
  assert.equal(f.logs[0].requestId, f.req.requestId);
  assert.equal(f.logs[0].path, "/api/v1/account");
  assert.equal(JSON.stringify(f.logs).includes("must-not-appear"), false);
});

test("logs safe error metadata without messages or personal data", async () => {
  const f = fixture("/reset?email=person@example.test");
  const sensitive = new Error("password=never-log email=person@example.test");
  sensitive.name = "password=do-not-log";
  await new Promise((resolve) =>
    f.interceptor
      .intercept(f.context, { handle: () => throwError(() => sensitive) })
      .subscribe({ error: resolve }),
  );
  assert.equal(f.logs[0].event, "http_request_error");
  assert.equal(f.logs[0].statusCode, 500);
  assert.equal(f.logs[1].outcome, "error");
  assert.equal(JSON.stringify(f.logs).includes("person@example.test"), false);
  assert.equal(JSON.stringify(f.logs).includes("never-log"), false);
  assert.equal(JSON.stringify(f.logs).includes("do-not-log"), false);
});

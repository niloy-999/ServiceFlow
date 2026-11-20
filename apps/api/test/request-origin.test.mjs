import assert from "node:assert/strict";
import { test } from "node:test";
import { ForbiddenException, InternalServerErrorException } from "@nestjs/common";
import { assertFrontendOrigin } from "../dist/identity/request-origin.js";

const originalWebAppUrl = process.env.WEB_APP_URL;
const originalNodeEnv = process.env.NODE_ENV;

function withWebAppUrl(value, callback) {
  if (value === undefined) {
    delete process.env.WEB_APP_URL;
  } else {
    process.env.WEB_APP_URL = value;
  }

  try {
    callback();
  } finally {
    if (originalWebAppUrl === undefined) {
      delete process.env.WEB_APP_URL;
    } else {
      process.env.WEB_APP_URL = originalWebAppUrl;
    }
  }
}

function withNodeEnv(value, callback) {
  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }

  try {
    callback();
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
}

test("Accepts the exact configured frontend origin", () => {
  withWebAppUrl("http://localhost:3000", () => {
    assert.doesNotThrow(() => assertFrontendOrigin("http://localhost:3000"));
  });
});

test("Rejects missing, null, and foreign origins", () => {
  withWebAppUrl("http://localhost:3000", () => {
    for (const origin of [undefined, "null", "http://evil.example"]) {
      assert.throws(
        () => assertFrontendOrigin(origin),
        (error) => error instanceof ForbiddenException && error.getStatus() === 403,
      );
    }
  });
});

test("Rejects an origin with a different scheme, port, or trailing path", () => {
  withWebAppUrl("https://app.example.com", () => {
    for (const origin of [
      "http://app.example.com",
      "https://app.example.com:8443",
      "https://app.example.com/path",
    ]) {
      assert.throws(
        () => assertFrontendOrigin(origin),
        (error) => error instanceof ForbiddenException && error.getStatus() === 403,
      );
    }
  });
});

test("Fails closed when WEB_APP_URL is missing or malformed", () => {
  withWebAppUrl(undefined, () => {
    assert.throws(
      () => assertFrontendOrigin("http://localhost:3000"),
      InternalServerErrorException,
    );
  });

  withWebAppUrl("not-a-valid-url", () => {
    assert.throws(
      () => assertFrontendOrigin("http://localhost:3000"),
      InternalServerErrorException,
    );
  });
});

test("Rejects WEB_APP_URL values containing paths or credentials", () => {
  for (const invalidUrl of [
    "http://localhost:3000/app",
    "https://user:password@app.example.com",
    "https://app.example.com/?next=/home",
  ]) {
    withWebAppUrl(invalidUrl, () => {
      assert.throws(() => assertFrontendOrigin(invalidUrl), InternalServerErrorException);
    });
  }
});

test("Requires HTTPS for the configured frontend origin in production", () => {
  withNodeEnv("production", () => {
    withWebAppUrl("http://localhost:3000", () => {
      assert.throws(
        () => assertFrontendOrigin("http://localhost:3000"),
        InternalServerErrorException,
      );
    });

    withWebAppUrl("https://app.example.com", () => {
      assert.doesNotThrow(() => assertFrontendOrigin("https://app.example.com"));
    });
  });
});

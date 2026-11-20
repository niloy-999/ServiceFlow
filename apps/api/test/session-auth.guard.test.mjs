import assert from "node:assert/strict";
import { test } from "node:test";
import { UnauthorizedException } from "@nestjs/common";
import { SessionAuthGuard } from "../dist/identity/session-auth.guard.js";

const validToken = "A".repeat(43);

const validatedSession = {
  sessionId: "session-123",
  userId: "user-456",
  expiresAt: new Date("2026-11-21T00:00:00.000Z"),
};

function createContext(cookie) {
  const request = {
    headers: cookie === undefined ? {} : { cookie },
  };

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  };

  return { context, request };
}

test("Rejects requests without a session cookie", async () => {
  let validationCalls = 0;

  const guard = new SessionAuthGuard({
    validateSession: async () => {
      validationCalls += 1;
      return validatedSession;
    },
  });

  const { context } = createContext();

  await assert.rejects(
    guard.canActivate(context),
    (error) => error instanceof UnauthorizedException && error.getStatus() === 401,
  );

  assert.equal(validationCalls, 0);
});

test("Rejects malformed session cookies without querying the session service", async () => {
  let validationCalls = 0;

  const guard = new SessionAuthGuard({
    validateSession: async () => {
      validationCalls += 1;
      return validatedSession;
    },
  });

  const { context } = createContext("__Host-serviceflow_session=invalid");

  await assert.rejects(
    guard.canActivate(context),
    (error) => error instanceof UnauthorizedException && error.getStatus() === 401,
  );

  assert.equal(validationCalls, 0);
});

test("Attaches validated session metadata and allows authenticated requests", async () => {
  let receivedToken;

  const guard = new SessionAuthGuard({
    validateSession: async (token) => {
      receivedToken = token;
      return validatedSession;
    },
  });

  const { context, request } = createContext(`__Host-serviceflow_session=${validToken}`);

  assert.equal(await guard.canActivate(context), true);
  assert.equal(receivedToken, validToken);
  assert.deepEqual(request.authSession, validatedSession);
  assert.equal("token" in request.authSession, false);
});

test("Rejects expired, revoked, or otherwise invalid sessions", async () => {
  const guard = new SessionAuthGuard({
    validateSession: async () => null,
  });

  const { context } = createContext(`__Host-serviceflow_session=${validToken}`);

  await assert.rejects(
    guard.canActivate(context),
    (error) => error instanceof UnauthorizedException && error.getStatus() === 401,
  );
});

test("Propagates session database errors instead of converting them to 401", async () => {
  const databaseError = new Error("Database unavailable");

  const guard = new SessionAuthGuard({
    validateSession: async () => {
      throw databaseError;
    },
  });

  const { context } = createContext(`__Host-serviceflow_session=${validToken}`);

  await assert.rejects(guard.canActivate(context), (error) => error === databaseError);
});

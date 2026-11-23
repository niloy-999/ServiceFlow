import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EmailDeliveryService } from "../dist/identity/email-delivery.service.js";

test("local provider writes private verification and reset messages", async () => {
  const cwd = process.cwd();
  const prevMode = process.env.EMAIL_DELIVERY;
  const prevNodeEnv = process.env.NODE_ENV;
  const temp = await mkdtemp(join(tmpdir(), "serviceflow-mail-test-"));
  try {
    process.chdir(temp);
    process.env.EMAIL_DELIVERY = "local";
    process.env.NODE_ENV = "development";
    const service = new EmailDeliveryService();
    await service.sendVerificationEmail("a@example.test", "https://local.test/verify?token=sample");
    await service.sendPasswordResetEmail("b@example.test", "https://local.test/reset?token=sample");
    const directory = join(temp, ".local/mail");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    const files = await readdir(directory);
    assert.equal(files.length, 2);
    const messages = await Promise.all(
      files.map(async (file) => ({
        mode: (await stat(join(directory, file))).mode & 0o777,
        body: await readFile(join(directory, file), "utf8"),
      })),
    );
    assert(messages.every(({ mode }) => mode === 0o600));
    assert(messages.some(({ body }) => body.includes("Verify your ServiceFlow email address")));
    assert(messages.some(({ body }) => body.includes("Reset your ServiceFlow password")));
  } finally {
    process.chdir(cwd);
    if (prevMode === undefined) delete process.env.EMAIL_DELIVERY;
    else process.env.EMAIL_DELIVERY = prevMode;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    await rm(temp, { recursive: true, force: true });
  }
});

test("rejects unknown provider and local provider outside development", () => {
  const prevMode = process.env.EMAIL_DELIVERY;
  const prevNodeEnv = process.env.NODE_ENV;
  try {
    process.env.EMAIL_DELIVERY = "smtp";
    process.env.NODE_ENV = "development";
    assert.throws(() => new EmailDeliveryService(), /No production email delivery provider/);
    process.env.EMAIL_DELIVERY = "local";
    process.env.NODE_ENV = "production";
    assert.throws(() => new EmailDeliveryService(), /only in development/);
  } finally {
    if (prevMode === undefined) delete process.env.EMAIL_DELIVERY;
    else process.env.EMAIL_DELIVERY = prevMode;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});

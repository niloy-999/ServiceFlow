import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

async function fixture({
  volumeExists,
  volumeId = "serviceflow-phase1-postgres-data|created-at",
  marker,
}) {
  const root = await mkdtemp(join(tmpdir(), "serviceflow-postgres-helper-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "infra/local/postgres"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, ".local"), { recursive: true });
  await writeFile(
    join(root, "scripts/local-postgres.sh"),
    await (
      await import("node:fs/promises")
    ).readFile(new URL("../../../scripts/local-postgres.sh", import.meta.url)),
  );
  await writeFile(
    join(root, ".env.local"),
    "POSTGRES_BOOTSTRAP_PASSWORD=local-test-value\nSERVICEFLOW_APP_PASSWORD=local-test-value\nSERVICEFLOW_MIGRATOR_PASSWORD=local-test-value\n",
  );
  await writeFile(join(root, "infra/local/postgres/compose.yaml"), "services: {}\n");
  if (marker !== undefined)
    await writeFile(join(root, ".local/serviceflow-postgres-volume-id"), marker);
  const fakeDocker = join(root, "bin/docker");
  await writeFile(
    fakeDocker,
    `#!/bin/sh
if [ "$1" = volume ] && [ "$2" = inspect ]; then
  if [ "$MOCK_VOLUME_EXISTS" != true ] && [ ! -e .mock-volume ]; then exit 1; fi
  case "$*" in *--format*) printf '%s\\n' "$MOCK_VOLUME_ID";; esac
  exit 0
fi
if [ "$1" = compose ]; then
  case "$*" in *" up "*) : > .mock-volume;; esac
  exit 0
fi
exit 2
`,
  );
  await chmod(fakeDocker, 0o700);
  const run = () =>
    spawnSync("sh", [join(root, "scripts/local-postgres.sh"), "up"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        MOCK_VOLUME_EXISTS: String(volumeExists),
        MOCK_VOLUME_ID: volumeId,
      },
    });
  return { root, run, volumeId };
}

test("refuses an existing volume with no matching ownership marker", async () => {
  const f = await fixture({ volumeExists: true });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /without this helper's ownership marker/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("refuses a mismatched marker and a stale marker", async () => {
  for (const input of [
    { volumeExists: true, marker: "different-volume|identity" },
    { volumeExists: false, marker: "stale-volume|identity" },
  ]) {
    const f = await fixture(input);
    try {
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing to/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test("allows only matching reuse and records a newly created volume once", async () => {
  const matching = await fixture({
    volumeExists: true,
    marker: "serviceflow-phase1-postgres-data|created-at",
  });
  try {
    assert.equal(matching.run().status, 0);
  } finally {
    await rm(matching.root, { recursive: true, force: true });
  }

  const fresh = await fixture({ volumeExists: false });
  try {
    const result = fresh.run();
    assert.equal(result.status, 0, result.stderr);
    const marker = await (
      await import("node:fs/promises")
    ).readFile(join(fresh.root, ".local/serviceflow-postgres-volume-id"), "utf8");
    assert.equal(marker, fresh.volumeId);
  } finally {
    await rm(fresh.root, { recursive: true, force: true });
  }
});

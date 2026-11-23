import "dotenv/config";
import { pathToFileURL } from "node:url";

import { Client } from "pg";
import { MfaCryptoService } from "../dist/identity/mfa-crypto.service.js";

const BATCH_SIZE = 100;
const LOCK_NAMESPACE = 20261123;
const LOCK_ID = 121;
const EXPECTED_ROLE = "serviceflow_migrator";

const TABLES = ["user_mfa", "mfa_enrollments"];

export function parseArguments(args) {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  let mode = "dry-run";
  let expectedDatabase = null;

  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const argument = normalizedArgs[index];

    if (argument === "--apply" || argument === "--verify") {
      if (mode !== "dry-run") {
        throw new Error("Choose only one execution mode.");
      }
      mode = argument === "--apply" ? "apply" : "verify";
      continue;
    }

    if (argument === "--database") {
      if (expectedDatabase !== null) {
        throw new Error("--database may only be supplied once.");
      }

      expectedDatabase = normalizedArgs[index + 1];
      index += 1;

      if (!expectedDatabase || expectedDatabase.startsWith("--")) {
        throw new Error("--database requires an expected database name.");
      }
      continue;
    }

    throw new Error("Unknown command-line argument.");
  }

  if (!expectedDatabase) {
    throw new Error("--database is required.");
  }

  if (!/^[A-Za-z0-9_-]{1,63}$/.test(expectedDatabase)) {
    throw new Error("Invalid expected database name.");
  }

  return { mode, expectedDatabase };
}

function createCryptoService() {
  if (
    !process.env.MFA_ENCRYPTION_KEYS ||
    !process.env.MFA_ENCRYPTION_LEGACY_KEY_ID ||
    !process.env.MFA_ENCRYPTION_ACTIVE_KEY_ID
  ) {
    throw new Error("Explicit MFA keyring and key IDs are required.");
  }

  if (process.env.MFA_ENCRYPTION_LEGACY_KEY_ID === process.env.MFA_ENCRYPTION_ACTIVE_KEY_ID) {
    throw new Error("The active key must differ from the legacy key.");
  }

  return new MfaCryptoService();
}

async function assertDatabaseIdentity(client, expectedDatabase) {
  const result = await client.query(`
    SELECT
      current_user AS role,
      current_database() AS database
  `);

  const identity = result.rows[0];

  if (identity.role !== EXPECTED_ROLE || identity.database !== expectedDatabase) {
    throw new Error("Database identity check failed.");
  }
}

async function assertTableSecurity(client) {
  const result = await client.query(
    `
      SELECT
        c.relname AS table_name,
        owner.rolname AS owner,
        c.relrowsecurity AS rls_enabled,
        c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
      JOIN pg_roles owner
        ON owner.oid = c.relowner
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
        AND c.relkind = 'r'
    `,
    [TABLES],
  );

  const metadata = new Map(result.rows.map((row) => [row.table_name, row]));

  for (const table of TABLES) {
    const row = metadata.get(table);

    if (
      !row ||
      row.owner !== EXPECTED_ROLE ||
      row.rls_enabled !== true ||
      row.rls_forced !== false
    ) {
      throw new Error("MFA table ownership or RLS check failed.");
    }
  }
}

async function acquireLock(client) {
  const result = await client.query("SELECT pg_try_advisory_lock($1, $2) AS acquired", [
    LOCK_NAMESPACE,
    LOCK_ID,
  ]);

  if (result.rows[0]?.acquired !== true) {
    throw new Error("Another MFA key-maintenance process is running.");
  }
}

async function releaseLock(client) {
  await client.query("SELECT pg_advisory_unlock($1, $2)", [LOCK_NAMESPACE, LOCK_ID]);
}

async function processTable(client, crypto, table, mode) {
  let cursor = null;
  let total = 0;
  let current = 0;
  let needsRotation = 0;
  let updated = 0;

  while (true) {
    let transactionOpen = false;

    try {
      if (mode === "apply") {
        await client.query("BEGIN");
        transactionOpen = true;
      }

      const lockClause = mode === "apply" ? "FOR UPDATE" : "";

      const result = await client.query(
        `
          SELECT id, encrypted_secret
          FROM public."${table}"
          WHERE ($1::uuid IS NULL OR id > $1::uuid)
          ORDER BY id
          LIMIT $2
          ${lockClause}
        `,
        [cursor, BATCH_SIZE],
      );

      if (result.rows.length === 0) {
        if (transactionOpen) {
          await client.query("COMMIT");
          transactionOpen = false;
        }

        break;
      }

      for (const row of result.rows) {
        const encrypted = row.encrypted_secret;

        // Authenticate every record, including records already on
        // the active key. Never trust the envelope header alone.
        const plaintext = crypto.decryptSecret(encrypted);

        try {
          const isCurrent = crypto.isEncryptedSecretCurrent(encrypted);

          total += 1;

          if (isCurrent) {
            current += 1;
          } else {
            needsRotation += 1;

            if (mode === "apply") {
              const replacement = crypto.encryptSecret(plaintext);

              const update = await client.query(
                `
                  UPDATE public."${table}"
                  SET encrypted_secret = $2
                  WHERE id = $1
                `,
                [row.id, replacement],
              );

              if (update.rowCount !== 1) {
                throw new Error("MFA record update failed.");
              }

              updated += 1;
            }
          }
        } finally {
          // Clear plaintext even if encryption or the database update fails.
          plaintext.fill(0);
        }
      }

      if (transactionOpen) {
        await client.query("COMMIT");
        transactionOpen = false;
      }

      // Advance only after the batch has committed successfully.
      cursor = result.rows[result.rows.length - 1].id;
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
      }

      throw error;
    }
  }

  return { total, current, needsRotation, updated };
}

function printTableResult(table, result) {
  console.log(
    `${table}: total=${result.total}, ` +
      `current=${result.current}, ` +
      `needs_rotation=${result.needsRotation}, ` +
      `updated=${result.updated}`,
  );
}

async function main() {
  const { mode, expectedDatabase } = parseArguments(process.argv.slice(2));

  if (!process.env.MIGRATION_DATABASE_URL) {
    throw new Error("MIGRATION_DATABASE_URL is required.");
  }

  const crypto = createCryptoService();

  const client = new Client({
    connectionString: process.env.MIGRATION_DATABASE_URL,
    application_name: "serviceflow-mfa-key-maintenance",
  });

  let connected = false;
  let locked = false;

  try {
    await client.connect();
    connected = true;

    await assertDatabaseIdentity(client, expectedDatabase);
    await assertTableSecurity(client);
    await acquireLock(client);
    locked = true;

    console.log(`MFA key maintenance mode: ${mode}`);
    console.log(`Target database: ${expectedDatabase}`);
    console.log(`Batch size: ${BATCH_SIZE}`);

    let totalRecords = 0;
    let remainingRecords = 0;

    for (const table of TABLES) {
      const result = await processTable(client, crypto, table, mode);
      printTableResult(table, result);

      totalRecords += result.total;
      remainingRecords += result.needsRotation;
    }

    if (mode === "apply") {
      console.log("Starting independent post-rotation verification.");

      for (const table of TABLES) {
        const result = await processTable(client, crypto, table, "verify");

        printTableResult(`${table} verification`, result);

        if (result.needsRotation !== 0) {
          throw new Error("Post-rotation verification found old-key records.");
        }
      }

      console.log("Post-rotation verification passed.");
    } else if (mode === "verify" && remainingRecords !== 0) {
      throw new Error("Verification found records requiring rotation.");
    } else if (mode === "dry-run") {
      console.log(
        `Dry-run complete: ${totalRecords} records inspected; ` +
          `${remainingRecords} require rotation. No records were modified.`,
      );
    } else {
      console.log("Verification passed: every record uses the active key.");
    }
  } finally {
    let cleanupFailed = false;

    if (locked) {
      try {
        await releaseLock(client);
      } catch {
        cleanupFailed = true;
        console.error("Warning: advisory lock release failed; closing connection.");
      }
    }

    if (connected) {
      try {
        // Closing the session also releases any remaining session-level lock.
        await client.end();
      } catch {
        cleanupFailed = true;
        console.error("Warning: database connection cleanup failed.");
      }
    }

    if (cleanupFailed) {
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    // Do not print raw database or crypto errors: they may contain
    // sensitive connection, query, or record information.
    console.error("MFA key maintenance failed. No further details were logged.");
    process.exitCode = 1;
  });
}

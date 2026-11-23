import { randomBytes } from "node:crypto";
import { mkdtemp, chmod, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "pg";
import dotenv from "dotenv";

const root = resolve(import.meta.dirname, "../../..");
dotenv.config({ path: join(root, ".env.local"), override: false, quiet: true });
const [mode, archiveArg] = process.argv.slice(2);
if (mode !== "backup" && mode !== "restore-drill") {
  throw new Error(
    "Usage: node apps/api/scripts/postgres-recovery-drill.mjs {backup|restore-drill} [archive]",
  );
}
const archive = mode === "backup" ? archiveArg : resolve(archiveArg ?? "");
if (!archive || !isAbsolute(archive) || !relative(root, archive).startsWith("../")) {
  throw new Error("Choose an absolute archive path outside the repository.");
}
const sourceUrl = process.env.MIGRATION_DATABASE_URL;
if (!sourceUrl) throw new Error("MIGRATION_DATABASE_URL must be configured in .env.local.");
const parseUrl = (value) => {
  const url = new URL(value);
  return {
    host: url.hostname,
    port: url.port || "5432",
    dbname: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
};
const clientConfig = ({ host, port, dbname, user, password }) => ({
  host,
  port: Number(port),
  database: dbname,
  user,
  password,
});
const serviceLine = (key, value) =>
  `${key}=${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}`;
const temp = await mkdtemp(join(tmpdir(), "serviceflow-pg-recovery-"));
await chmod(temp, 0o700);
const serviceFile = join(temp, "pg_service.conf");
const source = parseUrl(sourceUrl);
if (!process.env.POSTGRES_BOOTSTRAP_PASSWORD)
  throw new Error("POSTGRES_BOOTSTRAP_PASSWORD must be configured in .env.local.");
const admin = {
  ...source,
  dbname: "postgres",
  user: "serviceflow_bootstrap",
  password: process.env.POSTGRES_BOOTSTRAP_PASSWORD,
};
const adminUrl = `postgresql://${encodeURIComponent(admin.user)}:${encodeURIComponent(admin.password)}@${admin.host}:${admin.port}/${admin.dbname}`;
const adminClient = new Client({ connectionString: adminUrl });
const restoreName = `serviceflow_restore_drill_${randomBytes(8).toString("hex")}`;
let created = false;
let verified = false;
let adminConnected = false;
let archiveCreated = false;
let archiveComplete = false;

async function run(binary, args, env) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, PGSERVICEFILE: serviceFile, ...env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${binary} exited with status ${code}`)),
    );
  });
}
async function setServices(extra = "") {
  const content =
    [
      `[source]\n${Object.entries(source)
        .map(([k, v]) => serviceLine(k, v))
        .join("\n")}`,
      `[admin]\n${Object.entries(admin)
        .map(([k, v]) => serviceLine(k, v))
        .join("\n")}`,
      extra,
    ]
      .filter(Boolean)
      .join("\n\n") + "\n";
  await writeFile(serviceFile, content, { mode: 0o600, flag: "w" });
  await chmod(serviceFile, 0o600);
}

try {
  await setServices();
  if (mode === "backup") {
    await writeFile(archive, "", { flag: "wx", mode: 0o600 });
    archiveCreated = true;
    await run("pg_dump", ["--format=custom", "--file", archive, "--dbname=service=source"], {});
    const file = await stat(archive);
    if ((file.mode & 0o777) !== 0o600 || file.size === 0)
      throw new Error("Backup archive permissions or size validation failed.");
    archiveComplete = true;
    console.log(`Local custom-format backup created; bytes=${file.size}; path=${archive}`);
    process.exitCode = 0;
  } else {
    await adminClient.connect();
    adminConnected = true;
    const exists = await adminClient.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      restoreName,
    ]);
    if (exists.rowCount)
      throw new Error(
        "Generated restore target unexpectedly already exists; refusing to continue.",
      );
    await adminClient.query(`CREATE DATABASE "${restoreName}" OWNER serviceflow_migrator`);
    created = true;
    await adminClient.query(`REVOKE ALL ON DATABASE "${restoreName}" FROM PUBLIC`);
    await adminClient.query(`GRANT CONNECT ON DATABASE "${restoreName}" TO serviceflow_app`);
    const target = { ...source, dbname: restoreName };
    const targetSection = `[restore]\n${Object.entries(target)
      .map(([k, v]) => serviceLine(k, v))
      .join("\n")}`;
    const targetMigrator = {
      ...target,
      user: "serviceflow_migrator",
      password: decodeURIComponent(new URL(process.env.MIGRATION_DATABASE_URL).password),
    };
    const migrationSection = `[restore_migrator]\n${Object.entries(targetMigrator)
      .map(([k, v]) => serviceLine(k, v))
      .join("\n")}`;
    await setServices(`${targetSection}\n\n${migrationSection}`);
    await run(
      "pg_restore",
      ["--exit-on-error", "--no-owner", "--dbname=service=restore", archive],
      {},
    );
    const restored = new Client(clientConfig({ ...target, password: source.password }));
    await restored.connect();
    const status = await restored.query(
      `SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    const counts = {};
    for (const table of ["users", "businesses", "audit_events", "tenant_memberships"]) {
      const result = await restored.query(`SELECT count(*)::int AS count FROM "${table}"`);
      counts[table] = result.rows[0].count;
    }
    const invalidFk = await restored.query(
      "SELECT count(*)::int AS count FROM pg_constraint WHERE contype = 'f' AND NOT convalidated",
    );
    const rls = await restored.query(
      "SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('businesses','tenant_memberships','audit_events') AND c.relrowsecurity",
    );
    const owner = await restored.query(
      "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()",
    );
    const privilege = await restored.query(
      "SELECT has_database_privilege('serviceflow_app', current_database(), 'CONNECT') AS app_connect, has_database_privilege('serviceflow_app', current_database(), 'CREATE') AS app_create",
    );
    if (
      status.rows[0].count !== 18 ||
      invalidFk.rows[0].count !== 0 ||
      rls.rows[0].count !== 2 ||
      owner.rows[0].owner !== "serviceflow_migrator" ||
      !privilege.rows[0].app_connect ||
      privilege.rows[0].app_create
    )
      throw new Error(
        `Restore integrity validation failed: migrations=${status.rows[0].count}, invalidForeignKeys=${invalidFk.rows[0].count}, rlsTables=${rls.rows[0].count}, owner=${owner.rows[0].owner}, appConnect=${privilege.rows[0].app_connect}, appCreate=${privilege.rows[0].app_create}.`,
      );
    await restored.end();
    const app = new Client(
      clientConfig({
        ...target,
        user: "serviceflow_app",
        password: decodeURIComponent(new URL(process.env.DATABASE_URL).password),
      }),
    );
    await app.connect();
    const appAuditDelete = await app.query(
      "SELECT has_table_privilege(current_user, 'audit_events', 'DELETE') AS allowed",
    );
    const appBypass = await app.query(
      "SELECT rolsuper OR rolbypassrls AS elevated FROM pg_roles WHERE rolname = current_user",
    );
    const appRows = await app.query("SELECT count(*)::int AS count FROM tenant_memberships");
    if (appAuditDelete.rows[0].allowed || appBypass.rows[0].elevated || appRows.rows[0].count !== 0)
      throw new Error(
        "Restored runtime role has excessive privileges or can read tenant data without context.",
      );
    await app.end();
    await run(
      join(root, "scripts/pnpm.sh"),
      ["--filter", "@serviceflow/api", "exec", "prisma", "migrate", "status"],
      {
        DATABASE_URL: `postgresql://${encodeURIComponent(targetMigrator.user)}:${encodeURIComponent(targetMigrator.password)}@${target.host}:${target.port}/${restoreName}`,
        MIGRATION_DATABASE_URL: `postgresql://${encodeURIComponent(targetMigrator.user)}:${encodeURIComponent(targetMigrator.password)}@${target.host}:${target.port}/${restoreName}`,
        SHADOW_DATABASE_URL: process.env.SHADOW_DATABASE_URL,
        DOTENV_CONFIG_PATH: "/dev/null",
      },
    );
    verified = true;
    console.log(
      `Restore drill verified then cleaning only generated database ${restoreName}; committed migrations=${status.rows[0].count}; sample counts=${JSON.stringify(counts)}; foreign keys validated; RLS enabled; runtime grants restricted.`,
    );
  }
} finally {
  if (adminConnected) await adminClient.end().catch(() => {});
  if (archiveCreated && !archiveComplete) {
    await import("node:fs/promises").then(({ unlink }) => unlink(archive).catch(() => {}));
  }
  if (created && !verified) {
    console.error(
      `Restore target ${restoreName} was preserved because verification did not complete.`,
    );
  }
  if (created && verified) {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    const owned = await cleanup.query(
      "SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
      [restoreName],
    );
    const sessions = await cleanup.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1",
      [restoreName],
    );
    if (
      owned.rowCount === 1 &&
      owned.rows[0].owner === "serviceflow_migrator" &&
      sessions.rows[0].count === 0
    ) {
      await cleanup.query(`DROP DATABASE "${restoreName}"`);
    } else {
      throw new Error(
        "Verified drill database ownership or connection state changed; it was preserved for manual review.",
      );
    }
    await cleanup.end();
  }
  await import("node:fs/promises").then(({ rm }) => rm(temp, { recursive: true, force: true }));
}

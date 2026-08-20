// Migration behaviour, exercised against real PostgreSQL (PGlite over TCP)
// through the same drizzle-orm migrator that `drizzle-kit migrate` invokes for
// the `pg` driver:
//
//   drizzle-kit migrate
//     → preparePostgresDB(credentials).migrate      (drizzle-kit/bin.cjs)
//     → drizzle-orm/node-postgres/migrator.migrate
//     → readMigrationFiles(config) + PgDialect.migrate
//
// Nothing here touches a real database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test, { after, before, beforeEach } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const DB_PORT = 55_900 + (process.pid % 200);
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

let pglite;
let server;
let pool;
let db;

before(async () => {
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, port: DB_PORT, host: "127.0.0.1" });
  await server.start();
  // One pool for the whole file: PGlite serves a single connection, and
  // opening a fresh pool per run races with the previous one closing.
  pool = new Pool({
    connectionString: `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`,
    max: 1,
  });
  db = drizzle(pool);
});

after(async () => {
  await pool?.end().catch(() => {});
  await server?.stop();
  await pglite?.close();
});

beforeEach(async () => {
  await pglite.exec("DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
});

function runMigrate() {
  return migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

const rows = async (sql) => (await pglite.query(sql)).rows;
const journal = JSON.parse(
  readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
);

test("the journal lists both migrations and their files exist", () => {
  assert.deepEqual(
    journal.entries.map((entry) => entry.tag),
    ["0000_conscious_captain_cross", "0001_previous_speed"],
  );
  // Strictly increasing `when` is what makes the later migration eligible.
  const [first, second] = journal.entries;
  assert.ok(second.when > first.when, "0001 must be newer than 0000");
});

test("a clean database receives both migrations and ends with the buyer columns", async () => {
  await runMigrate();

  const applied = await rows("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at");
  assert.equal(applied.length, 2, "both migrations must be recorded");
  assert.deepEqual(
    applied.map((row) => Number(row.created_at)),
    journal.entries.map((entry) => entry.when),
    "created_at is the journal's `when`, not a wall clock",
  );

  const columns = await rows(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'",
  );
  const names = columns.map((row) => row.column_name);
  for (const column of ["buyer_type", "buyer_inn", "buyer_name"]) {
    assert.ok(names.includes(column), `orders.${column} must exist after 0001`);
  }
});

test("running migrate twice is a no-op", async () => {
  await runMigrate();
  await runMigrate();
  const applied = await rows("SELECT id FROM drizzle.__drizzle_migrations");
  assert.equal(applied.length, 2, "a second run must not re-apply anything");
});

test("the recorded hash is sha256 of the raw file, so line endings change it", async () => {
  await runMigrate();
  const applied = await rows("SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at");

  for (const [index, entry] of journal.entries.entries()) {
    const raw = readFileSync(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url)).toString();
    assert.equal(
      applied[index].hash,
      createHash("sha256").update(raw).digest("hex"),
      `${entry.tag} hash must be sha256 of the file exactly as it sits on disk`,
    );

    // The same content with the other line endings hashes differently. That is
    // why a hash recorded before a CRLF checkout no longer matches the file —
    // and why it does not matter: nothing ever compares it.
    const swapped = raw.includes("\r\n")
      ? raw.replaceAll("\r\n", "\n")
      : raw.replaceAll("\n", "\r\n");
    assert.notEqual(createHash("sha256").update(swapped).digest("hex"), applied[index].hash);
  }
});

test("a stale hash does not stop a pending migration from running", async () => {
  // Apply everything, then rewrite 0000's recorded hash to nonsense and drop
  // the 0001 bookkeeping and columns. If hashes mattered, the rerun would
  // complain; it does not, because migrate never reads them back.
  await runMigrate();
  await pglite.exec(`
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = ${journal.entries[1].when};
    UPDATE drizzle.__drizzle_migrations SET hash = 'deadbeef';
    ALTER TABLE orders DROP COLUMN buyer_type, DROP COLUMN buyer_inn, DROP COLUMN buyer_name;
    ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_buyer_requisites;
  `);

  await runMigrate();

  const columns = await rows(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'buyer_type'",
  );
  assert.equal(columns.length, 1, "0001 must run again despite the corrupted hash");
});

test("REPRODUCTION: a created_at at or above 0001's `when` silently skips it", async () => {
  // This is the only condition under which migrate reports success and leaves
  // 0001 unapplied. The rule in PgDialect.migrate is
  //   apply when  newest created_at  <  migration.folderMillis
  // so a 0000 row stamped with a timestamp that is not older than 0001 hides
  // 0001 permanently — no error, no output, nothing to notice.
  const [first, second] = journal.entries;

  await pglite.exec(`
    CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    );
  `);
  // Apply 0000's SQL by hand and record it with an inflated created_at.
  const sql = readFileSync(new URL(`../drizzle/${first.tag}.sql`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await pglite.exec(statement);
  }
  await pglite.exec(
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('whatever', ${second.when})`,
  );

  await runMigrate();

  const columns = await rows(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'buyer_type'",
  );
  assert.equal(columns.length, 0, "0001 is skipped, exactly as reported in production");

  const applied = await rows("SELECT id FROM drizzle.__drizzle_migrations");
  assert.equal(applied.length, 1, "and nothing new is recorded");
});

test("correcting that row to 0000's own `when` lets 0001 apply, without rerunning 0000", async () => {
  // The repair for the state above: set the stray row's created_at back to the
  // timestamp 0000 actually carries. 0000's SQL is not re-executed — its row
  // stays, so migrate still considers it done.
  const [first, second] = journal.entries;

  await pglite.exec(`
    CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    );
  `);
  const sql = readFileSync(new URL(`../drizzle/${first.tag}.sql`, import.meta.url), "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim()) await pglite.exec(statement);
  }
  await pglite.exec(
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('whatever', ${second.when})`,
  );

  // The repair.
  await pglite.exec(
    `UPDATE drizzle.__drizzle_migrations SET created_at = ${first.when} WHERE created_at = ${second.when}`,
  );

  await runMigrate();

  const columns = await rows(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'buyer_type'",
  );
  assert.equal(columns.length, 1, "0001 applied");

  const applied = await rows("SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at");
  assert.deepEqual(
    applied.map((row) => Number(row.created_at)),
    [first.when, second.when],
    "0000 keeps its single row; 0001 adds one",
  );

  // 0000 ran exactly once: a second orders table would have failed the rerun.
  const tables = await rows(
    "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_name = 'orders'",
  );
  assert.equal(tables[0].c, 1);
});

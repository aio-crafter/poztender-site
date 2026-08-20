#!/usr/bin/env node
//
// Read-only migration diagnostics.
//
// Reports what Drizzle sees on disk, what the database says is applied, and
// which migrations `drizzle-kit migrate` would run next — using the same
// journal parsing, the same hash algorithm and the same decision rule as the
// installed drizzle-orm.
//
//   DATABASE_URL='postgresql://…?sslmode=verify-full' node scripts/migration-status.mjs
//
// It issues SELECTs only: no schema is created, no row is written, and the
// migrations table is not created if it is missing. Safe against production.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

const MIGRATIONS_FOLDER = new URL("../drizzle/", import.meta.url);
const SCHEMA = "drizzle";
const TABLE = "__drizzle_migrations";

/**
 * Mirrors readMigrationFiles() in drizzle-orm/migrator.cjs: the hash is
 * sha256 over the *entire raw file*, byte for byte. Line endings are part of
 * it, which is why the same migration hashes differently after a checkout
 * that rewrites LF to CRLF.
 */
function readMigrations() {
  const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", MIGRATIONS_FOLDER), "utf8"));
  return {
    journal,
    migrations: journal.entries.map((entry) => {
      const raw = readFileSync(new URL(`${entry.tag}.sql`, MIGRATIONS_FOLDER)).toString();
      return {
        tag: entry.tag,
        folderMillis: entry.when,
        hash: createHash("sha256").update(raw).digest("hex"),
        hashIfLf: createHash("sha256").update(raw.replace(/\r\n/g, "\n")).digest("hex"),
        crlf: raw.includes("\r\n"),
        statements: raw.split("--> statement-breakpoint").length,
      };
    }),
  };
}

function pad(value, width) {
  return String(value).padEnd(width);
}

const { journal, migrations } = readMigrations();

console.log("── on disk ──────────────────────────────────────────────");
console.log(`journal version : ${journal.version}`);
console.log(`journal dialect : ${journal.dialect}`);
console.log(
  journal.dialect === "postgresql"
    ? ""
    : "  note: `migrate` never reads this field — it selects the driver from\n" +
        "  drizzle.config.ts. A stale value here is cosmetic for migrate, but\n" +
        "  `drizzle-kit generate`/`check` do use it.",
);
console.log("");
for (const migration of migrations) {
  console.log(`${pad(migration.tag, 34)} when=${migration.folderMillis}`);
  console.log(`  sha256(file)   ${migration.hash}${migration.crlf ? "   [file has CRLF]" : ""}`);
  if (migration.crlf) {
    console.log(`  sha256(as LF)  ${migration.hashIfLf}`);
  }
  console.log(`  statements     ${migration.statements}`);
}

if (!process.env.DATABASE_URL) {
  console.log("\nDATABASE_URL is not set — skipping the database side.");
  process.exit(0);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const { rows: exists } = await pool.query(
    "SELECT to_regclass($1) IS NOT NULL AS present",
    [`${SCHEMA}.${TABLE}`],
  );

  console.log("\n── in the database ──────────────────────────────────────");
  if (!exists[0].present) {
    console.log(`${SCHEMA}.${TABLE} does not exist — no migration has ever been applied.`);
    console.log("Every migration listed above would run.");
  } else {
    const { rows: applied } = await pool.query(
      `SELECT id, hash, created_at FROM ${SCHEMA}.${TABLE} ORDER BY created_at DESC`,
    );
    if (applied.length === 0) {
      console.log("the table exists but is empty — every migration above would run.");
    } else {
      for (const row of applied) {
        const match = migrations.find((m) => m.hash === row.hash || m.hashIfLf === row.hash);
        console.log(
          `id=${pad(row.id, 4)} created_at=${pad(row.created_at, 15)} hash=${row.hash.slice(0, 16)}… ` +
            (match ? `→ ${match.tag}` : "→ no file on disk hashes to this"),
        );
      }

      // The rule, verbatim from PgDialect.migrate in drizzle-orm: a migration
      // runs if and only if the newest recorded created_at is strictly less
      // than its folderMillis. The hash is written but never compared, and the
      // set of already-applied tags is never consulted.
      const newest = Number(applied[0].created_at);
      console.log("\n── what `drizzle-kit migrate` would do next ─────────────");
      console.log(`rule: apply when  ${newest} (newest created_at)  <  migration.when`);
      console.log("");
      let pending = 0;
      for (const migration of migrations) {
        const willRun = newest < migration.folderMillis;
        if (willRun) pending += 1;
        console.log(
          `  ${willRun ? "RUN " : "skip"}  ${pad(migration.tag, 34)} when=${migration.folderMillis}`,
        );
      }
      if (pending === 0) {
        console.log("\nNothing would run. If a migration you expect is marked `skip`,");
        console.log("its `when` is not greater than the newest recorded created_at —");
        console.log("that, and not the hash, is what makes migrate exit silently.");
      }
    }
  }
} finally {
  await pool.end().catch(() => {});
}

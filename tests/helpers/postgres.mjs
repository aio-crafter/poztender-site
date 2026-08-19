// A real PostgreSQL for the tests.
//
// PGlite is PostgreSQL compiled to WebAssembly, exposed here over a TCP socket
// speaking the actual wire protocol. That matters: the built worker connects
// through the same bundled `pg` driver it uses in production, and the UNIQUE
// constraints, transactions and conditional UPDATE that carry the idempotency
// guarantees are executed by genuine PostgreSQL rather than an emulation.
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

export async function startTestDatabase(port) {
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();

  // The committed migration is what runs, so the tests exercise the same DDL
  // that will be applied to the managed database.
  const migration = await readFile(
    new URL("../../drizzle/0000_conscious_captain_cross.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) await db.exec(sql);
  }

  return {
    db,
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    async reset() {
      await db.exec("TRUNCATE access_grants, orders RESTART IDENTITY CASCADE;");
    },
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

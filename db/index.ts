import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let pool: Pool | undefined;
let database: Database | undefined;

/**
 * TLS is configured in DATABASE_URL and nowhere else.
 *
 * node-postgres merges the parsed connection string *over* the config object
 * (`config = Object.assign({}, config, parse(config.connectionString))` in
 * pg/lib/connection-parameters.js), and pg-connection-string creates an `ssl`
 * object as soon as the URL carries any of sslmode/sslcert/sslkey/sslrootcert.
 * So an `ssl` option passed here is silently discarded whenever the URL names
 * an sslmode. A second switch in code would look authoritative while having no
 * effect, which is worse than having none — hence no `ssl` option here and no
 * DATABASE_SSL variable.
 *
 * Neon requires TLS and its certificate comes from a publicly trusted CA, so
 * `sslmode=verify-full` verifies both the chain and the hostname against
 * Node's own trust store: no CA bundle to ship, and no `rejectUnauthorized:
 * false` anywhere in this project.
 */
function assertTransportSecurity(connectionString: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL");
  }

  // Loopback is how the test suite reaches its own PostgreSQL. Nothing leaves
  // the host, so TLS is not required there.
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) return;

  const sslmode = url.searchParams.get("sslmode");

  // verify-full is the one mode that means the same thing in both of
  // pg-connection-string's branches, so it is the only one accepted outright.
  if (sslmode === "verify-full") return;

  if (sslmode === null || ["disable", "allow", "no-verify"].includes(sslmode)) {
    throw new Error(
      `DATABASE_URL must carry sslmode=verify-full for a remote database (found ${
        sslmode ?? "no sslmode"
      }). Payment records must not travel over an unverified connection.`,
    );
  }

  // `uselibpqcompat=true` switches pg to libpq semantics immediately, where
  // prefer/require set rejectUnauthorized to false and verify-ca skips the
  // hostname check. Combined with anything but verify-full that is an
  // unverified connection right now, not a future risk.
  if (url.searchParams.get("uselibpqcompat") === "true") {
    throw new Error(
      `DATABASE_URL combines uselibpqcompat=true with sslmode=${sslmode}, which disables ` +
        "certificate verification. Use sslmode=verify-full and drop uselibpqcompat.",
    );
  }

  // prefer / require / verify-ca without libpq compatibility. pg 8 still
  // treats these as verify-full, and warns that pg 9 will adopt libpq
  // semantics — at which point `require` stops verifying the certificate.
  // Loud rather than fatal, because the connection is genuinely verified today.
  console.error(
    `[db] DATABASE_URL uses sslmode=${sslmode}. Switch to sslmode=verify-full: ` +
      "pg 9 will downgrade this mode to an unverified connection.",
  );
}

export function getDb(): Database {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. The payment flow cannot record orders without it.",
    );
  }

  if (!database) {
    assertTransportSecurity(connectionString);
    pool = new Pool({
      connectionString,
      // The container serves a low-traffic site; a small pool keeps well
      // inside the connection limit of a managed instance. Neon's pooled
      // endpoint multiplexes on its side, so this stays modest.
      max: Number(process.env.DATABASE_POOL_MAX ?? "5") || 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // Without a listener, a dropped idle connection raises an unhandled error
    // event and takes the whole process down.
    pool.on("error", (error) => {
      console.error("[db] idle client error", error.message);
    });
    database = drizzle(pool, { schema });
  }

  return database;
}

export function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

/** Closes the pool. Used by tests; the server keeps it open for its lifetime. */
export async function closeDb() {
  await pool?.end();
  pool = undefined;
  database = undefined;
}

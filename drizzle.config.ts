import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./db/schema.ts",
  dialect: "postgresql",
  // Read from the environment only. A connection string must never be written
  // into a file in this repository.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});

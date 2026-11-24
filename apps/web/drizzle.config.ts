import { defineConfig } from "drizzle-kit";

// drizzle-kit only writes migrations here; wrangler applies them, matching
// `migrations_pattern` in wrangler.jsonc.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/platform/db/schema.ts",
  out: "./migrations",
});

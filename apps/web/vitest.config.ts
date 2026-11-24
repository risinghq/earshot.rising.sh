import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import solidPlugin from "@solidjs/vite-plugin";
import { accessSync, constants } from "node:fs";
import { defineConfig } from "vitest/config";

// Miniflare keeps the tests' storage under os.tmpdir(), and a Durable Object
// or KV write waits for its commit to reach that disk: about 60 ms per write
// on ext4, under 1 ms in memory. Test storage is thrown away, so it lives in
// shared memory where the host has it.
try {
  accessSync("/dev/shm", constants.W_OK);
  process.env.TMPDIR = "/dev/shm";
} catch {}

// The same files wrangler applies; wrangler.jsonc explains the pattern.
const migrations = await readD1Migrations({
  projectPath: new URL(".", import.meta.url).pathname,
  migrationsDir: "migrations",
  migrationsPattern: "migrations/{*.sql,*/migration.sql}",
});
const migrationModule = "virtual:web-migrations";
const migrationPlugin = {
  name: "web-migrations",
  resolveId(id: string) {
    return id === migrationModule ? `\0${migrationModule}` : undefined;
  },
  load(id: string) {
    return id === `\0${migrationModule}`
      ? `export default ${JSON.stringify(migrations)};`
      : undefined;
  },
};

// Two projects: the Worker's tests run in the Workers runtime, and the
// browser components' tests run in happy-dom, since Workers have no DOM.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          migrationPlugin,
          cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } }),
        ],
        test: {
          name: "worker",
          include:
            process.env.PULL_BENCH === "1"
              ? ["test/bench.test.ts"]
              : ["test/**/*.test.ts", "!test/bench.test.ts"],
          setupFiles: ["test/setup.ts"],
          sequence: { concurrent: false },
        },
      },
      {
        plugins: [solidPlugin({ include: ["client/**/*.tsx"] })],
        test: {
          name: "client",
          environment: "happy-dom",
          include: ["client/**/*.test.{ts,tsx}"],
        },
      },
    ],
  },
});

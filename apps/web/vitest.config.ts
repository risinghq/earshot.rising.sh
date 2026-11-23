import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import solidPlugin from "@solidjs/vite-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  new URL("./migrations", import.meta.url).pathname,
);
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
          sequence: { concurrent: false },
        },
      },
      {
        plugins: [solidPlugin({ include: ["client/**/*.tsx"] })],
        test: {
          name: "client",
          environment: "happy-dom",
          include: ["client/**/*.test.tsx"],
        },
      },
    ],
  },
});

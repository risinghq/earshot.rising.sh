// Every Worker test file starts from a migrated database and every test from
// the rows the migrations seed. Each file already starts with empty storage,
// so the schema is built once per file in one batch. Between tests the tables
// are emptied, the seed rows put back in one batch and the cache cleared.
// No code reads d1_migrations, so the batch does not record the migrations.
//
// A test that created a Durable Object leaves sockets and a stored alarm that
// keep writing to D1. reset() deletes every binding's storage without waking
// the objects, so after such a test the next one rebuilds from scratch instead.
// listDurableObjectIds keeps every id ever created until reset(), so clearing
// objects one by one costs more with each test.
import { env, listDurableObjectIds, reset } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
import migrations from "virtual:web-migrations";

let restore: D1PreparedStatement[] = [];

async function migrate() {
  await env.DB.batch(
    migrations.flatMap((m) => m.queries).map((q) => env.DB.prepare(q)),
  );
}

async function snapshot() {
  const { results: tables } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  const statements = [
    env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    env.DB.prepare("DELETE FROM sqlite_sequence"),
  ];
  for (const { name } of tables) {
    statements.push(env.DB.prepare(`DELETE FROM "${name}"`));
    const { results: rows } = await env.DB.prepare(
      `SELECT * FROM "${name}"`,
    ).all<Record<string, unknown>>();
    for (const row of rows) {
      const columns = Object.keys(row);
      statements.push(
        env.DB.prepare(
          `INSERT INTO "${name}" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map((_, i) => `?${i + 1}`).join(", ")})`,
        ).bind(...Object.values(row)),
      );
    }
  }
  return statements;
}

async function clearCache() {
  let cursor: string | undefined;
  do {
    const page = await env.CACHE.list({ cursor });
    await Promise.all(page.keys.map((key) => env.CACHE.delete(key.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);
}

async function objectsExist() {
  for (const namespace of [env.ROOMS, env.MATCHMAKER, env.SOLO])
    if ((await listDurableObjectIds(namespace)).length > 0) return true;
  return false;
}

beforeAll(async () => {
  await migrate();
  restore = await snapshot();
});

async function migrated() {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  ).first<{ n: number }>();
  return row!.n > 0;
}

beforeEach(async () => {
  if (await objectsExist()) await reset();
  // reset() can leave D1 in place, so the schema is checked, not assumed gone.
  if (await migrated()) await env.DB.batch(restore);
  else await migrate();
  await clearCache();
});

import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { sources } from "./schema";

export type Db = DrizzleD1Database;

export type SourceRow = typeof sources.$inferSelect;

// A list travels as one JSON array read back with json_each, so a statement
// binds one value however long the list is: D1 binds at most 100.
export const jsonRows = (rows: unknown[]) =>
  sql`json_each(${JSON.stringify(rows)})`;
// A field of the current json_each row; `name` is a code constant.
export const jsonField = <T>(name: string) =>
  sql<T>`json_extract(value, ${sql.raw(`'$.${name}'`)})`;

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

// Drizzle's batch() takes a non-empty tuple, which a list built at run time
// is not typed as.
export function batchOf(items: BatchItem<"sqlite">[]): Batch {
  if (items.length === 0) throw new Error("an empty batch");
  return items as Batch;
}

// Runs writes in batches of `size`, each batch one round trip and one
// transaction. The list may be empty.
export async function batchWrites(
  db: Db,
  writes: BatchItem<"sqlite">[],
  size = 100,
) {
  for (let index = 0; index < writes.length; index += size)
    await db.batch(batchOf(writes.slice(index, index + size)));
}

const handles = new WeakMap<D1Database, Db>();

// One query builder per D1 binding: the binding is the same object across a
// Worker's requests, so the builder is made once.
export function database(d1: D1Database): Db {
  let db = handles.get(d1);
  if (db === undefined) {
    db = drizzle(d1);
    handles.set(d1, db);
  }
  return db;
}

export * as t from "./schema";

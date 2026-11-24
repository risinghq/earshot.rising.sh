import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

export type Db = DrizzleD1Database;

// Runs writes in batches of `size`, each batch one round trip and one
// transaction. Drizzle's batch() takes a non-empty tuple; a list may be empty.
export async function batchWrites(
  db: Db,
  writes: BatchItem<"sqlite">[],
  size = 100,
) {
  for (let index = 0; index < writes.length; index += size) {
    const [first, ...rest] = writes.slice(index, index + size);
    await db.batch([first, ...rest]);
  }
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

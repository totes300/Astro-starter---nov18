// The content version in D1: one row, read and written on the primary, so a bump is seen by the next read
// anywhere. Only renders and the webhooks read it, never a cached response.

import type { ContentVersionStore } from "./content-version";

export type D1Like = {
  exec(query: string): Promise<unknown>;
  prepare(query: string): {
    bind(...values: unknown[]): { first<T>(): Promise<T | null>; run(): Promise<unknown> };
  };
};

const VERSION_KEY = "content-version";

const CREATE_TABLE = "CREATE TABLE IF NOT EXISTS route_cache_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

export function createD1VersionStore(db: D1Like): ContentVersionStore {
  let ready: Promise<unknown> | null = null;

  // Created on first use, so a fresh database needs no migration step in the deploy.
  function ensureTable(): Promise<unknown> {
    ready ??= db.exec(CREATE_TABLE).catch((error: unknown) => {
      ready = null;

      throw error;
    });

    return ready;
  }

  return {
    async get() {
      await ensureTable();

      const row = await db
        .prepare("SELECT value FROM route_cache_state WHERE key = ?")
        .bind(VERSION_KEY)
        .first<{ value: string }>();

      return row?.value ?? null;
    },
    async set(version) {
      await ensureTable();
      await db
        .prepare("INSERT INTO route_cache_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .bind(VERSION_KEY, version)
        .run();
    },
  };
}

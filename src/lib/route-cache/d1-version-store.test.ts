import assert from "node:assert/strict";
import { test } from "node:test";
import { createContentVersion, INITIAL_CONTENT_VERSION } from "./content-version";
import { createD1VersionStore, type D1Like } from "./d1-version-store";

/** Answers the two statements the store sends, over one row, and counts the table setup. */
function fakeD1(failExec = 0) {
  const rows = new Map<string, string>();
  const calls = { exec: 0 };
  const db: D1Like = {
    async exec(query) {
      calls.exec += 1;

      if (calls.exec <= failExec) {
        throw new Error("D1 unavailable");
      }

      assert.match(query, /^CREATE TABLE IF NOT EXISTS route_cache_state/);
    },
    prepare(query) {
      return {
        bind(...values) {
          return {
            async first<T>() {
              const value = rows.get(String(values[0]));

              return (value === undefined ? null : { value }) as T | null;
            },
            async run() {
              assert.match(query, /^INSERT INTO route_cache_state/);
              rows.set(String(values[0]), String(values[1]));
            },
          };
        },
      };
    },
  };

  return { db, calls };
}

test("a fresh database answers the initial version, and a bump is read back", async () => {
  const { db, calls } = fakeD1();
  const version = createContentVersion(createD1VersionStore(db));

  assert.equal(await version.read(), INITIAL_CONTENT_VERSION);

  const bumped = await version.bump();

  assert.equal(await version.readFresh(), bumped);
  assert.equal(calls.exec, 1, "the table is set up once per isolate");
});

test("a failed table setup is retried on the next read rather than remembered", async () => {
  const { db, calls } = fakeD1(1);
  const store = createD1VersionStore(db);

  await assert.rejects(store.get());
  assert.equal(await store.get(), null);
  assert.equal(calls.exec, 2);
});

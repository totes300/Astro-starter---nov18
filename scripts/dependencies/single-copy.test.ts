import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Every nested copy ships again in the Studio bundle, and plugin updates keep nesting them.
const SINGLE_COPY = ["@sanity/ui", "motion", "framer-motion", "motion-dom", "motion-utils"];

type Lockfile = { packages: Record<string, { version?: string }> };

const lockfile = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")) as Lockfile;

function installedCopies(lock: Lockfile, name: string) {
  return Object.entries(lock.packages)
    .filter(([path]) => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))
    .map(([path, entry]) => `${path}@${entry.version}`);
}

test("installedCopies finds the hoisted copy and every nested one", () => {
  const lock: Lockfile = {
    packages: {
      "": {},
      "node_modules/@sanity/ui": { version: "4.0.7" },
      "node_modules/sanity/node_modules/@sanity/ui": { version: "4.4.9" },
      "node_modules/@sanity/ui-extra": { version: "1.0.0" },
    },
  };

  assert.deepEqual(installedCopies(lock, "@sanity/ui"), [
    "node_modules/@sanity/ui@4.0.7",
    "node_modules/sanity/node_modules/@sanity/ui@4.4.9",
  ]);
});

for (const name of SINGLE_COPY) {
  test(`package-lock.json installs one copy of ${name}`, () => {
    const copies = installedCopies(lockfile, name);

    assert.ok(
      copies.length <= 1,
      `${name} is installed ${copies.length} times:\n  ${copies.join("\n  ")}\n` +
        "Pin the root to a version every copy's range accepts and run npm dedupe. A nested copy npm keeps goes by " +
        "deleting its package-lock.json entries and running npm install."
    );
  });
}

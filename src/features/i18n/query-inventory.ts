// Every `defineQuery` exactly as typegen finds it, for the tests that must see each one: a trimmed feature's drop out.

import { join, relative } from "node:path";
import { findQueriesInPath, getResolver } from "@sanity/codegen";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** `typegen.path` in `sanity.cli.ts`, verbatim; `ghost-guard.test.ts` fails when the two drift. */
export const TYPEGEN_PATHS = [
  "./src/**/*.{ts,tsx,astro}",
  "!./src/pages/**/*.astro",
  "./sanity/**/*.{ts,tsx}",
  "./sanity.config.ts",
];

export type InventoriedQuery = { name: string; file: string; query: string };

/** `errors` lists every file typegen could not read, whose queries it would silently drop. */
export async function inventoryQueries(): Promise<{ queries: InventoriedQuery[]; errors: string[] }> {
  // No `registerBabel()`: tsx already registers `.ts` for the resolver, and babel would take over its loader.
  const { queries: modules } = findQueriesInPath({
    path: TYPEGEN_PATHS.map((path) => (path.startsWith("!") ? `!${join(ROOT, path.slice(1))}` : join(ROOT, path))),
    resolver: getResolver(ROOT),
  });
  const queries: InventoriedQuery[] = [];
  const errors: string[] = [];

  for await (const { filename, queries: found, errors: failed } of modules) {
    errors.push(...failed.map(({ message }) => message));
    queries.push(...found.map(({ variable, query }) => ({ name: variable.id.name, file: relative(ROOT, filename), query })));
  }

  return { queries, errors };
}

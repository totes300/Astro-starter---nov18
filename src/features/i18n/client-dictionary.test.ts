import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SRC = join(ROOT, "src");
const DICTIONARY = join(SRC, "features", "i18n", "strings.ts");
const DICTIONARIES = join(SRC, "features", "i18n", "dictionaries");

const IMPORTS =
  /\bimport\s+(?!type\b)(?:[^'"`;]*?\bfrom\s*)?["']([^"']+)["']|\bexport\s+(?!type\b)[^'"`;]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;

const SCRIPT_BLOCK = /<script(?![^>]*\bis:inline\b)[^>]*>([\s\S]*?)<\/script>/g;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
  );
}

function specifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  return [...code.matchAll(IMPORTS)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/** The file an import names, through the `~/` aliases or a relative path; `undefined` for a package. */
function resolveImport(from: string, specifier: string): string | undefined {
  const bare = specifier.split("?")[0] ?? "";
  let base: string;

  if (bare.startsWith("~/sanity/")) {
    base = join(ROOT, "sanity", bare.slice("~/sanity/".length));
  } else if (bare.startsWith("~/")) {
    base = join(SRC, bare.slice(2));
  } else if (bare.startsWith(".")) {
    base = resolve(dirname(from), bare);
  } else {
    return undefined;
  }

  return [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts")].find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile()
  );
}

test("no browser script reaches the UI dictionary, which would ship every language to every visitor", () => {
  const sources = files(SRC);
  const roots = [
    ...sources.filter((file) => file.endsWith("Element.ts")).map((file) => ({ file, code: readFileSync(file, "utf8") })),
    ...sources
      .filter((file) => file.endsWith(".astro"))
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(SCRIPT_BLOCK)].map((match) => ({ file, code: match[1] ?? "" }))),
  ];
  const parent = new Map<string, string>();
  const queue = roots.flatMap(({ file, code }) => specifiers(code).map((specifier) => ({ from: file, specifier })));
  const reached: string[] = [];

  for (const { from, specifier } of queue) {
    const file = resolveImport(from, specifier);

    if (!file || parent.has(file)) {
      continue;
    }

    parent.set(file, from);

    if (file === DICTIONARY || file.startsWith(`${DICTIONARIES}/`)) {
      reached.push(file);
      continue;
    }

    if (/\.(ts|tsx|js|mjs)$/.test(file)) {
      queue.push(...specifiers(readFileSync(file, "utf8")).map((next) => ({ from: file, specifier: next })));
    }
  }

  const chains = reached.map((file) => {
    const chain = [file];

    while (parent.has(chain[0] as string) && chain.length < 20) {
      chain.unshift(parent.get(chain[0] as string) as string);
    }

    return chain.map((step) => relative(ROOT, step)).join(" -> ");
  });

  assert.ok(roots.length > 0, "no browser script found");
  assert.deepEqual(chains, [], "render the string on the server into a data attribute instead");
});

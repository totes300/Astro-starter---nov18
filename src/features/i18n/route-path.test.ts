// Locale routing rewrites a prefixed request before the route renders, so a page that read its path off the URL or
// its params would query, link and mark current the unprefixed twin. Routes and components read `Astro.locals`.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCANNED_DIRS = ["src", "templates"];
const SCANNED_EXTENSIONS = [".astro", ".hbs"];

// The specimen route reads its own section name, which the rewrite keeps; it is never a stored path.
const ALLOWED_PARAMS = [join("src", "pages", "section-preview", "[section].astro")];

const BANNED = [
  { pattern: /Astro\.url\.pathname/, hint: "read `Astro.locals.path`, or `Astro.originPathname` for a link back" },
  { pattern: /Astro\.(?:currentLocale|preferredLocale)/, hint: "read `Astro.locals.locale`" },
  { pattern: /Astro\.params(?:\.[A-Za-z_$]|\[)/, hint: "read `Astro.locals.path`", allowed: ALLOWED_PARAMS },
];

function scannedFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) =>
    readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
      .map((file) => join(dir, file))
      .filter((file) => SCANNED_EXTENSIONS.some((extension) => file.endsWith(extension)))
  );
}

test("no route or component reads its path or locale off the rewritten URL", () => {
  const offences = scannedFiles().flatMap((file) =>
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .flatMap((line, index) => {
        const banned = BANNED.find(({ pattern, allowed }) => pattern.test(line) && !allowed?.includes(file));

        return banned ? [`${file}:${index + 1} ${banned.hint}`] : [];
      })
  );

  assert.deepEqual(offences, []);
});

test("every route and scaffold that looks a document up by URI takes it from `Astro.locals.path`", () => {
  const lookups = scannedFiles().flatMap((file) => {
    const declaration = readFileSync(join(ROOT, file), "utf8").match(/const uri = (.+)/);

    return declaration?.[1] ? [{ file, from: declaration[1] }] : [];
  });

  // The catch-all serves every page in every project, so the scan can never pass on an empty list.
  assert.ok(lookups.some(({ file }) => file === join("src", "pages", "[...uri].astro")));

  for (const { file, from } of lookups) {
    assert.match(from, /^Astro\.locals\.path\b/, file);
  }
});

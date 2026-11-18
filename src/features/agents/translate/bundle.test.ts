import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Every Studio module but the tests, which load what they check on purpose. */
function studioSources(dir = "sanity"): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return studioSources(path);
    }

    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Static imports only: `import(` keeps a module in a chunk of its own. */
const staticImporters = (module: RegExp) =>
  studioSources()
    .filter((file) => [...read(file).matchAll(/^import[^;]*?from "([^"]+)";/gms)].some(([, from = ""]) => module.test(from)))
    .map((file) => relative(ROOT, join(ROOT, file)));

describe("Translate with AI's weight on the rest of the Studio and the server", () => {
  it("loads the document dialog on first open, not with every document's actions", () => {
    assert.deepEqual(staticImporters(/\/translate-dialog$/), []);
    assert.match(read("sanity/ai-translation/translate-action.tsx"), /React\.lazy\(\(\) => import\("\.\/translate-dialog"\)/);
  });

  it("loads the Settings panel when Settings > Translations opens", () => {
    assert.deepEqual(staticImporters(/\/site-translation-input$/), []);
    assert.match(
      read("sanity/schemas/documents/site-settings.tsx"),
      /React\.lazy\(\(\) =>\s+import\("\.\.\/\.\.\/inputs\/site-translation-input"\)/
    );
  });

  it("imports the schema extract as JSON, which a build minifies, rather than as its pretty-printed text", () => {
    const route = read("src/pages/api/agents/translate.ts");

    assert.match(route, /await import\("(\.\.\/)+sanity-schema\.json"\)/);
    assert.doesNotMatch(route, /sanity-schema\.json\?raw/);
  });
});

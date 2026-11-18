import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { IS_I18N_ENABLED, LOCALES } from "~/sanity/i18n";

const ROOT = new URL("../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

/** `sanity/i18n.ts` as a build sees it: Vite's `define` swaps the constant for a literal before anything runs. */
async function i18nBuiltWith(value: boolean): Promise<{ IS_I18N_ENABLED: boolean }> {
  const { outputText } = ts.transpileModule(read("sanity/i18n.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext } });
  const built = outputText.replace(/\b__I18N_ENABLED__\b/g, JSON.stringify(value));

  return import(`data:text/javascript,${encodeURIComponent(built)}`);
}

describe("IS_I18N_ENABLED at build time", () => {
  it("is defined by the Astro config from LOCALES, the one switch", () => {
    assert.match(read("astro.config.mjs"), /__I18N_ENABLED__: JSON\.stringify\(LOCALE_IDS\.length > 1\)/);
  });

  it("follows the literal a build defines, so a bundler can drop the other mode's code", async () => {
    // The opposite of what LOCALES says, so only the defined value can produce it.
    const defined = !(LOCALES.length > 1);

    assert.equal((await i18nBuiltWith(defined)).IS_I18N_ENABLED, defined);
  });

  it("falls back to LOCALES where nothing defines it: scripts, tests and the config itself", () => {
    assert.equal(IS_I18N_ENABLED, LOCALES.length > 1);
  });
});

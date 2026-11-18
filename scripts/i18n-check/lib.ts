// The locale mode `sanity/i18n.ts` does not run, planned from its source text, and the throwaway copy it is tried in.
// Kept out of run.ts, `npm run i18n:check`, so it is unit tested. Workflow: ./README.md

import { constants, cpSync, existsSync, symlinkSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { listLocales, otherLocaleMode } from "../sanity-migrations/lib/locales";
import { LANGUAGE_ID } from "../trim-features/language-removal";

export const LOCALES_FILE = "sanity/i18n.ts";

export const DICTIONARIES_DIR = "src/features/i18n/dictionaries";

export const TYPES_FILE = "sanity/types.ts";

/** Comma-separated locales `strings.test.ts` lets go without a UI dictionary, and no others. */
export const UNTRANSLATED_ENV = "I18N_CHECK_UNTRANSLATED";

export type ModeSwitch = {
  /** The config after the switch. */
  source: string;
  /** `single`: every other entry commented out. `multi`: every commented candidate enabled. `none`: one locale, no candidate. */
  mode: "single" | "multi" | "none";
  defaultLocale?: string;
  switched: string[];
  /** Enabled candidates with no dictionary file; `strings.test.ts` is told to expect exactly these. */
  untranslated: string[];
  /** Why the config cannot be switched. Empty means it can. */
  problems: string[];
};

/** Plans the other locale mode; `hasDictionary` answers for a locale other than the default. */
export function planModeSwitch(source: string, hasDictionary: (locale: string) => boolean): ModeSwitch {
  const list = listLocales(source);
  const result = otherLocaleMode(source);
  const target = list && list.active.length > 1 ? "single" : "multi";
  const switched = target === "single" ? result.disabled : result.enabled;
  const problems = [
    ...result.refused.map(({ id, reason }) => (id ? `${id}: ${reason}` : reason)),
    // Each id reaches a URL prefix, so only a language code goes through.
    ...switched.filter((id) => !LANGUAGE_ID.test(id)).map((id) => `${JSON.stringify(id)} is not a language code.`),
  ];
  // With no candidate there is no other mode to test, which is a project's choice, not a fault.
  const mode = list && problems.length === 0 && switched.length === 0 ? "none" : target;

  return {
    source: result.source,
    mode,
    defaultLocale: list?.defaultLocale,
    switched,
    untranslated: mode === "multi" ? result.enabled.filter((locale) => !hasDictionary(locale)) : [],
    problems,
  };
}

/** A UI dictionary on disk, the way `src/features/i18n/strings.ts` registers a language other than the default. */
export function hasDictionaryIn(root: string): (locale: string) => boolean {
  return (locale) => existsSync(join(root, DICTIONARIES_DIR, `${locale}.ts`));
}

export function describeSwitch(plan: Pick<ModeSwitch, "mode" | "switched" | "defaultLocale">): string {
  const defaultLocale = plan.defaultLocale ?? "the default locale";

  if (plan.mode === "none") {
    return `${defaultLocale} alone, with no commented candidate`;
  }

  return plan.mode === "single"
    ? `${defaultLocale} alone (${plan.switched.join(", ")} commented out)`
    : `several locales (${plan.switched.join(", ")} enabled)`;
}

/** Queries typegen extracted: it writes one `// Variable:` line per query, and drops one it cannot evaluate silently. */
export function countQueries(types: string): number {
  return types.match(/^\/\/ Variable: /gm)?.length ?? 0;
}

/** Top-level folders a copy never takes: dependencies are linked, and the rest is git, build output or backups. */
const SKIPPED = new Set(["node_modules", ".git", "dist", ".astro", ".wrangler", "backups"]);

/** Whether a path, relative to the project root, belongs in the copy. Env files never do: `.env` is linked. */
export function isCopied(path: string): boolean {
  const [top = ""] = path.split(sep);
  const name = basename(path);
  const isEnvFile = name === ".env" || (name.startsWith(".env.") && name !== ".env.example");

  return !SKIPPED.has(top) && !isEnvFile;
}

/** A copy of the working tree, uncommitted work included, cloned where the file system can. */
export function copyWorkingTree(root: string, target: string): void {
  cpSync(root, target, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
    filter: (source) => isCopied(relative(root, source)),
  });

  if (existsSync(join(root, "node_modules"))) {
    symlinkSync(join(root, "node_modules"), join(target, "node_modules"), "junction");
  }

  // Linked, never copied: an interrupted run must not leave the tokens behind in a temporary folder.
  if (existsSync(join(root, ".env"))) {
    symlinkSync(join(root, ".env"), join(target, ".env"));
  }
}

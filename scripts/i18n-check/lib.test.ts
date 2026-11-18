import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listLocales } from "../sanity-migrations/lib/locales";
import { copyWorkingTree, countQueries, describeSwitch, hasDictionaryIn, isCopied, LOCALES_FILE, planModeSwitch } from "./lib";

// Fixture locales stand on their own: en is the default, fr has a dictionary and de does not.
const config = (entries: string) => `export const LOCALES = [
  { id: "en", title: "English", region: "GB" },
${entries}] as const;

export const DEFAULT_LOCALE = "en";
`;

const MULTI = config(`  { id: "fr", title: "Français", region: "FR" },
  { id: "de", title: "Deutsch", region: "DE" },
`);

const SINGLE = config(`  // { id: "fr", title: "Français", region: "FR" },
  // { id: "de", title: "Deutsch", region: "DE" },
`);

const hasDictionary = (locale: string) => locale === "fr";

test("several locales switch to the default alone, and back to the same config", () => {
  const single = planModeSwitch(MULTI, hasDictionary);

  assert.equal(single.mode, "single");
  assert.deepEqual(single.switched, ["fr", "de"]);
  assert.deepEqual(single.untranslated, []);
  assert.deepEqual(single.problems, []);
  assert.equal(single.source, SINGLE);
  assert.equal(describeSwitch(single), "en alone (fr, de commented out)");

  const multi = planModeSwitch(single.source, hasDictionary);

  assert.equal(multi.mode, "multi");
  assert.deepEqual(multi.switched, ["fr", "de"]);
  assert.equal(multi.source, MULTI);
  assert.equal(describeSwitch(multi), "several locales (fr, de enabled)");
});

test("an enabled candidate with no dictionary is the one locale the strings test is told to expect", () => {
  const plan = planModeSwitch(SINGLE, hasDictionary);

  assert.deepEqual(plan.untranslated, ["de"]);
});

test("a config that cannot be switched says why instead of switching part of it", () => {
  const shared = planModeSwitch(config(`  { id: "fr", title: "Français" }, { id: "de", title: "Deutsch" },\n`), hasDictionary);
  const computed = planModeSwitch(`export const LOCALES = ["en", "fr"].map((id) => ({ id }));\n`, hasDictionary);

  assert.match(shared.problems.join("\n"), /^fr: it shares a line/m);
  assert.match(computed.problems.join("\n"), /not a literal array/);
});

test("one locale with no commented candidate has no other mode, which is not a problem", () => {
  const alone = planModeSwitch(config(""), hasDictionary);

  assert.equal(alone.mode, "none");
  assert.deepEqual(alone.problems, []);
  assert.deepEqual(alone.switched, []);
  assert.equal(alone.source, config(""));
  assert.equal(describeSwitch(alone), "en alone, with no commented candidate");
});

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const RUN = fileURLToPath(new URL("./run.ts", import.meta.url));

/** Runs `npm run i18n:check` in a throwaway project holding only `sanity/i18n.ts`. */
function runCheck(locales: string, args: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "i18n-check-cli-"));

  try {
    mkdirSync(join(root, "sanity"));
    writeFileSync(join(root, LOCALES_FILE), locales);

    const result = spawnSync(process.execPath, [`--import=${TSX}`, RUN, ...args], { cwd: root, encoding: "utf8" });

    return { ...result, after: readFileSync(join(root, LOCALES_FILE), "utf8") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("npm run i18n:check passes one locale with no candidate before copying anything", () => {
  const { status, stdout, stderr } = runCheck(config(""), ["--dry-run"]);

  assert.equal(status, 0, stderr);
  assert.match(stdout, /has no other locale mode to check/);
  assert.doesNotMatch(stdout, /Summary/);
});

test("npm run i18n:check says which mode it would check, and its dry run leaves the tree alone", () => {
  const { status, stdout, stderr, after } = runCheck(MULTI, ["--dry-run"]);

  assert.equal(status, 0, stderr);
  assert.match(stdout, /en alone \(fr, de commented out\)/);
  assert.match(stdout, /Dry run complete/);
  assert.equal(after, MULTI);
});

test("the real config switches to its other mode and back without a problem", () => {
  const source = readFileSync(new URL(`../../${LOCALES_FILE}`, import.meta.url), "utf8");
  const before = listLocales(source);
  const there = planModeSwitch(source, () => true);
  const back = planModeSwitch(there.source, () => true);

  assert.deepEqual(there.problems, []);
  assert.deepEqual(back.problems, []);
  assert.notDeepEqual(listLocales(there.source)?.active, before?.active);
  assert.deepEqual(listLocales(back.source)?.active, before?.active);
  assert.deepEqual(listLocales(back.source)?.commented, before?.commented);
});

test("countQueries counts the queries typegen wrote", () => {
  const types = "// Source: a.ts\n// Variable: PageQ\nexport type PageQResult = {};\n// Variable: SiteQ\n// Variable:Broken\n";

  assert.equal(countQueries(types), 2);
  assert.equal(countQueries(""), 0);
});

test("isCopied leaves out dependencies, git, build output, backups and env files", () => {
  for (const path of [
    "node_modules",
    ".git",
    "dist",
    ".astro",
    ".wrangler",
    "backups",
    ".env",
    ".env.local",
    join("src", ".env"),
  ]) {
    assert.equal(isCopied(path), false, path);
  }

  for (const path of ["", "src", join("src", "a.ts"), ".env.example", join("seed", "seed-dataset.tar.gz"), "distribution"]) {
    assert.equal(isCopied(path), true, path);
  }
});

test("copyWorkingTree copies the tree and links node_modules and .env rather than copying them", () => {
  const parent = mkdtempSync(join(tmpdir(), "i18n-check-test-"));
  const root = join(parent, "root");
  const target = join(parent, "copy");

  try {
    for (const folder of ["src", "node_modules/pkg", ".git", "dist", "src/features/i18n/dictionaries"]) {
      mkdirSync(join(root, folder), { recursive: true });
    }

    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(root, "node_modules/pkg/index.js"), "");
    writeFileSync(join(root, ".git/HEAD"), "");
    writeFileSync(join(root, "dist/index.html"), "");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, ".env.example"), "SECRET=\n");
    writeFileSync(join(root, "src/features/i18n/dictionaries/fr.ts"), "");
    symlinkSync("a.ts", join(root, "src/alias.ts"));

    copyWorkingTree(root, target);

    assert.equal(readFileSync(join(target, "src/a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(readFileSync(join(target, ".env.example"), "utf8"), "SECRET=\n");
    assert.equal(readlinkSync(join(target, "src/alias.ts")), "a.ts", "a relative link stays inside the copy");
    assert.equal(lstatSync(join(target, "node_modules")).isSymbolicLink(), true);
    assert.equal(lstatSync(join(target, ".env")).isSymbolicLink(), true);
    assert.equal(existsSync(join(target, ".git")), false);
    assert.equal(existsSync(join(target, "dist")), false);
    assert.equal(hasDictionaryIn(target)("fr"), true);
    assert.equal(hasDictionaryIn(target)("de"), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a candidate that is not a language code is refused, so nothing odd reaches a URL prefix", () => {
  for (const id of ["../x", "fr\\nNODE_OPTIONS=--inspect", "Fr_FR"]) {
    const plan = planModeSwitch(config(`  // { id: "${id}", title: "Odd" },\n`), () => false);

    assert.match(plan.problems.join("\n"), /is not a language code/, id);
  }

  assert.deepEqual(planModeSwitch(config(`  // { id: "pt-BR", title: "Português" },\n`), () => true).problems, []);
});

// Applies each trim to a throwaway `git worktree` and checks what is left still builds. The working
// tree is never written to, and nothing here reads or writes a dataset.

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { printDone, printHeader, printStep, printSummary } from "../lib/cli";
import { applyEdits, describeEdit, type FileEdits, isInScope, resolveEdits } from "./edits";
import { FEATURES, type Feature, onDisk, resolveSelection, shapesOf } from "./features";
import { isOfferable, readProjectRecord, recordTrimmed, statusesOf, today, writeProjectRecord } from "./project";

const root = process.cwd();

type Result = { id: string; ok: boolean; detail: string };

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/** A commit of the tree as it stands, uncommitted work included, without disturbing it. */
function snapshot(): string {
  return git(["stash", "create"]) || git(["rev-parse", "HEAD"]);
}

function withWorktree<T>(sha: string, run: (dir: string) => T): T {
  const parent = mkdtempSync(join(tmpdir(), "trim-verify-"));
  const dir = join(parent, "tree");

  git(["worktree", "add", "--detach", "--quiet", dir, sha]);

  try {
    // Reused rather than reinstalled: the copy is throwaway and `npm install` would be the slow part.
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"), "dir");

    // Linked, never copied: typegen reads the project id from it, and a copy would leave the tokens behind.
    if (existsSync(join(root, ".env"))) {
      symlinkSync(join(root, ".env"), join(dir, ".env"));
    }

    // `git stash create` records tracked changes only, so new files would be missing from the copy.
    for (const file of git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      copyFileSync(join(root, file), join(dir, file));
    }

    return run(dir);
  } finally {
    try {
      git(["worktree", "remove", "--force", dir]);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
}

/** The resolution `trim.ts` performs, against the copy: apply what resolves, collect what does not. */
function applyFeature(dir: string, feature: Feature, groups: FileEdits[]): string[] {
  const read = (file: string) => readFileSync(join(dir, file), "utf8");
  const { applicable, unresolved } = resolveEdits(groups, (path) => existsSync(join(dir, path)), read);

  for (const path of [...feature.paths.flatMap(shapesOf), ...(feature.docs ?? [])]) {
    rmSync(join(dir, path), { recursive: true, force: true });
  }

  for (const { file, edits } of applicable) {
    writeFileSync(join(dir, file), applyEdits(read(file), edits, file));
  }

  return unresolved.map(
    ({ file, edit, matches, reason }) => `${file}: ${describeEdit(edit)} matched ${matches} times${reason ? ` (${reason})` : ""}`
  );
}

// Typegen as `trim.ts` runs it, so stale generated types cannot fail a trim; `DO_NOT_TRACK` keeps it off the Sanity API.
const GATES: { label: string; command: string; args: string[]; env?: Record<string, string> }[] = [
  { label: "typegen", command: "npm", args: ["run", "sanity:typegen"], env: { DO_NOT_TRACK: "1" } },
  { label: "astro check", command: "npx", args: ["astro", "check"] },
  { label: "npm test", command: "npm", args: ["test"] },
];

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const FAILURE = /✖|AssertionError|error ts\(|Cannot find|has no exported member|is not assignable|^Error:/;

function firstErrors(output: string): string {
  const lines = output
    .split("\n")
    .map((line) => line.replace(ANSI, "").trimEnd())
    .filter((line) => !line.includes("✔") && FAILURE.test(line.trim()));

  return (lines.length > 0 ? lines.slice(0, 5) : output.split("\n").slice(-6)).join("\n        ");
}

const SOURCE = /\.(ts|tsx|astro|mjs)$/;

// The manifest names every path it deletes, and `types.ts` is generated with `// Source:` comments.
const NOT_A_REFERENCE = ["scripts/trim-features", "sanity/types.ts"];

/**
 * Anything still naming a path the trim deleted.
 *
 * The typechecker is blind to a stale `import()` in a `.d.ts`, because the base tsconfig sets
 * `skipLibCheck`, and that is exactly where a custom element registry lists the files it types.
 */
function danglingReferences(dir: string, deleted: string[]): string[] {
  const needles = deleted.map((path) => path.replace(/^src\//, "").replace(SOURCE, "")).filter((path) => path.includes("/"));
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".astro")) {
        continue;
      }

      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        walk(full);
        continue;
      }

      if (!SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        continue;
      }

      const relative = full.slice(dir.length + 1);

      if (NOT_A_REFERENCE.some((path) => relative.startsWith(path))) {
        continue;
      }

      const source = readFileSync(full, "utf8");

      for (const needle of needles) {
        if (source.includes(needle)) {
          found.push(`${relative} still names ${needle}`);
        }
      }
    }
  };

  walk(dir);

  return found;
}

function verifyGroup(dir: string, features: Feature[], id: string): Result {
  // `requires` and `requiresAbsent` are judged against the copy as it arrived. A feature deleting the
  // thing one names must not change which edits were due to run, which is how `trim.ts` resolves the plan.
  const plans = features.map((feature) => ({
    feature,
    groups: feature.edits
      .filter((entry) => isInScope(entry, (path) => existsSync(join(dir, path))))
      .map((entry) => ({ ...entry, requires: undefined, requiresAbsent: undefined })),
  }));

  const deleted = features.flatMap((feature) =>
    feature.paths.flatMap((path) => onDisk(path, (candidate) => existsSync(join(dir, candidate))))
  );
  const unresolved = plans.flatMap(({ feature, groups }) => applyFeature(dir, feature, groups));

  // Recorded as `trim.ts` records it, so a feature the record lists as ported never outlives its files.
  writeProjectRecord(
    dir,
    recordTrimmed(
      readProjectRecord(dir),
      features.map((feature) => feature.id),
      today()
    )
  );

  for (const { label, command, args, env } of GATES) {
    const run = spawnSync(command, args, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (run.status !== 0) {
      return { id, ok: false, detail: `❌ ${label}\n        ${firstErrors(`${run.stdout}${run.stderr}`)}` };
    }
  }

  const dangling = danglingReferences(dir, deleted);

  if (dangling.length > 0) {
    return { id, ok: false, detail: `❌ dangling references\n        ${dangling.slice(0, 5).join("\n        ")}` };
  }

  return { id, ok: true, detail: unresolved.length > 0 ? `✅ ${unresolved.length} left for a human` : "✅" };
}

/** What each `--feature` invocation actually removes, deduped: coupled pairs resolve to one run. */
function selections(asked: string[]): { id: string; features: Feature[] }[] {
  // Only what is still here to remove: a trimmed, adopted or never-had feature is not a trim to verify.
  const statuses = statusesOf(readProjectRecord(root), (path) => existsSync(join(root, path)));
  const removable = (feature: Feature) => isOfferable(statuses.get(feature.id) ?? "present");
  const ids = asked.length > 0 ? [asked] : FEATURES.filter(removable).map((feature) => [feature.id]);
  const seen = new Set<string>();

  return ids.flatMap((group) => {
    const features = resolveSelection(group).features.filter(removable);
    const key = features
      .map((feature) => feature.id)
      .sort()
      .join("+");

    if (features.length === 0 || seen.has(key)) {
      return [];
    }

    seen.add(key);

    return [{ id: key.replace(/\+/g, " + "), features }];
  });
}

function main(): void {
  const groups = selections(process.argv.slice(2).filter((arg) => !arg.startsWith("--")));

  printHeader("🧪", "Trim verify", [
    "Applies each trim to a throwaway copy of this repository and checks the result still builds.",
    "The working tree is never written to, and nothing here reads or writes a dataset.",
  ]);

  const sha = snapshot();
  const results: Result[] = [];

  for (const { id, features } of groups) {
    printStep("🧪", `${id}…`);
    results.push(withWorktree(sha, (dir) => verifyGroup(dir, features, id)));
  }

  if (results.length === 0) {
    printDone("Nothing to verify.", "No feature asked for is still here to remove; `npm run trim -- --status` says why.");
    return;
  }

  printSummary(results.map((result) => ({ label: result.id, value: result.detail })));

  if (results.some((result) => !result.ok)) {
    process.exitCode = 1;

    return;
  }

  printDone("Every trim leaves a tree that still builds.", `${results.length} feature(s) verified`);
}

main();

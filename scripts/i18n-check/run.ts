#!/usr/bin/env node

// `npm run i18n:check`: the locale mode sanity/i18n.ts does not run, built and tested in a throwaway copy of this tree.
// The working tree is never written to, and nothing here writes to a dataset. Details: ./README.md

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { fail, finishDryRun, printDone, printDryRunNotice, printHeader, printStep, printSummary } from "../lib/cli";
import {
  copyWorkingTree,
  countQueries,
  describeSwitch,
  hasDictionaryIn,
  LOCALES_FILE,
  planModeSwitch,
  TYPES_FILE,
  UNTRANSLATED_ENV,
} from "./lib";

const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

const program = new Command();

program
  .name("i18n-check")
  .description("Typegen, astro check and npm test with sanity/i18n.ts switched to the locale mode it does not run")
  .option("--dry-run", "Show the plan and exit without copying or running anything", false)
  .parse();

const options = program.opts<{ dryRun: boolean }>();
const root = process.cwd();

let current: ChildProcess | undefined;
let interrupted = false;

// A terminal Ctrl-C already reached the running step; a lone SIGTERM did not, so it is passed on. Cleanup then runs.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    interrupted = true;
    current?.kill(signal);
  });
}

type Step = { icon: string; label: string };

function run(
  { icon, label }: Step,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {}
): Promise<void> {
  if (interrupted) {
    return Promise.reject(new Error("Interrupted."));
  }

  printStep(icon, label);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });

    current = child;
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      current = undefined;

      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} ${signal ? `stopped by ${signal}` : `exited with code ${code}`}.`));
      }
    });
  });
}

async function typegen(copy: string, label: string): Promise<number> {
  await run({ icon: "🧬", label }, npmBin, ["run", "sanity:typegen"], copy);

  return countQueries(readFileSync(join(copy, TYPES_FILE), "utf8"));
}

async function main() {
  printHeader("🌐", "Locale mode check", [
    "Switches a throwaway copy of this tree to the locale mode sanity/i18n.ts does not run, then runs typegen,",
    "astro check and npm test there. The working tree is never written to.",
  ]);

  if (options.dryRun) {
    printDryRunNotice();
  }

  const plan = planModeSwitch(readFileSync(join(root, LOCALES_FILE), "utf8"), hasDictionaryIn(root));

  if (plan.problems.length > 0) {
    fail(`${LOCALES_FILE} cannot be switched to its other locale mode.`, ...plan.problems);
  }

  if (plan.mode === "none") {
    printDone(
      `${LOCALES_FILE} has no other locale mode to check.`,
      `It configures ${describeSwitch(plan)}. Keep a language you switched off as a comment in LOCALES to test it.`
    );

    return;
  }

  const hasEnv = existsSync(join(root, ".env"));

  printSummary([
    { label: "Mode", value: describeSwitch(plan) },
    ...(plan.untranslated.length > 0
      ? [{ label: "No dictionary", value: `${plan.untranslated.join(", ")} (${UNTRANSLATED_ENV} tells the strings test)` }]
      : []),
    { label: "Copy", value: "a temporary folder, deleted afterwards (node_modules and .env linked)" },
    { label: "Steps", value: "typegen as configured, typegen switched (no query may drop out), astro check, npm test" },
    ...(hasEnv ? [] : [{ label: ".env", value: "missing: typegen reads the Sanity project id from it or from the shell" }]),
  ]);

  if (options.dryRun) {
    finishDryRun();
  }

  const parent = mkdtempSync(join(tmpdir(), "i18n-check-"));
  const copy = join(parent, "tree");
  let failure: string | undefined;
  let counts: [number, number] | undefined;

  try {
    printStep("📁", `Copying the tree to ${copy}`);
    copyWorkingTree(root, copy);

    const configured = await typegen(copy, "Typegen, as configured");

    writeFileSync(join(copy, LOCALES_FILE), plan.source);

    const switched = await typegen(copy, `Typegen, ${describeSwitch(plan)}`);

    counts = [configured, switched];

    if (switched < configured) {
      throw new Error(
        `Typegen extracted ${switched} queries switched and ${configured} as configured: a query stopped evaluating.`
      );
    }

    await run({ icon: "🔎", label: "astro check" }, npxBin, ["--no", "--package=astro", "--", "astro", "check"], copy);
    await run({ icon: "🧪", label: "npm test" }, npmBin, ["test"], copy, { [UNTRANSLATED_ENV]: plan.untranslated.join(",") });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }

  if (failure) {
    fail(
      `The ${plan.mode === "single" ? "single-locale" : "multi-locale"} build failed.`,
      failure,
      `Mode: ${describeSwitch(plan)}`
    );
  }

  printDone(
    `The ${plan.mode === "single" ? "single-locale" : "multi-locale"} build passes.`,
    `${describeSwitch(plan)}; typegen ${counts?.[1]} queries (${counts?.[0]} as configured)`
  );
}

main().catch((error) => {
  fail("Unexpected error.", error instanceof Error ? (error.stack ?? error.message) : String(error));
});

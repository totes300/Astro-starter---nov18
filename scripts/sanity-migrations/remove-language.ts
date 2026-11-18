#!/usr/bin/env node

// Deletes a language LOCALES no longer configures from a dataset, on the plan `npm run trim` uses: every copy of its
// documents, its translation links, its text on shared documents and assets. See docs/features/internationalization.md

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { I18N_DOCUMENT_TYPES, LOCALIZED_FIELDS } from "../../sanity/constants";
import { DEFAULT_LOCALE, LOCALE_IDS } from "../../sanity/i18n";
import {
  askMultiSelect,
  askText,
  cancel,
  confirmOrCancel,
  fail,
  finishDryRun,
  printDone,
  printDryRunNotice,
  printHeader,
  printStep,
  printSummary,
} from "../lib/cli";
import { buildExportArgs, formatExportTimestamp, liveTargetError, runSanityCommand } from "../sanity-dataset/lib";
import {
  describeLanguageCount,
  formatLanguageRemovalPlan,
  hasLanguageLeftovers,
  isEmptyPlan,
  type LanguageRemovalConfig,
  type LanguageRemovalPlan,
  languageCensus,
  languageRemovalMutations,
  planGrowth,
  planLanguageRemoval,
  readLanguageRemovalInput,
  readLanguageScan,
  refusalReasons,
  removalBlocker,
  strandedLanguages,
} from "../trim-features/language-removal";
import {
  AI_RESULTS_QUERY,
  type AiResultCleanup,
  type AiResultDocument,
  aiResultCleanupMutations,
  describeAiResultCleanup,
  isEmptyCleanup,
  planAiResultCleanup,
} from "./lib/ai-results";
import { commitInBatches, type Migration, openMigration } from "./lib/client";

const program = new Command();

program
  .name("migrate-remove-language")
  .description("Delete a language LOCALES no longer configures, and the links and text it leaves on shared content")
  .option("--language <id...>", "Languages to remove (defaults to a picker over the ones the dataset still holds)")
  .option("--dataset <name>", "Dataset to clean (defaults to a picker, or the .env dataset with --yes or --dry-run)")
  .option("--allow-live-target <dataset>", "Allow --yes to delete from the .env dataset; repeat its name to confirm")
  .option("--dry-run", "Show the plan and exit without prompting or writing (wins over --yes)", false)
  .option(
    "-y, --yes",
    "Skip the prompts and delete (needs --language while a language this site no longer serves holds anything)",
    false
  );

program.parse();

const options = program.opts<{
  language?: string[];
  dataset?: string;
  allowLiveTarget?: string;
  dryRun: boolean;
  yes: boolean;
}>();

const BASE_CONFIG = {
  defaultLocale: DEFAULT_LOCALE,
  keep: [...LOCALE_IDS],
  i18nTypes: I18N_DOCUMENT_TYPES,
  localizedFields: LOCALIZED_FIELDS,
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `--language` checked against the rule the plan enforces, so a refusal names the reason before anything is read. */
function checkedLanguages(languages: readonly string[]): string[] {
  for (const language of languages) {
    const blocker = removalBlocker(language, BASE_CONFIG);

    if (blocker) {
      fail(blocker, "Nothing was read or changed.");
    }
  }

  return [...new Set(languages)];
}

/** The languages to remove: the flag, else a picker over what the dataset holds. Empty means only cleaning text. */
async function chooseLanguages(migration: Migration): Promise<string[]> {
  const scan = await readLanguageScan(migration.read, BASE_CONFIG);

  if (!scan) {
    fail(`Could not read "${migration.dataset}", so nothing was changed.`);
  }

  const census = languageCensus(scan, BASE_CONFIG);
  const stranded = strandedLanguages(census);

  if (stranded.length === 0) {
    return [];
  }

  if (!migration.interactive) {
    if (options.yes && !options.dryRun) {
      fail(
        "--yes needs --language: a language this site no longer serves still holds documents, links or text, so an unattended run names the language.",
        `Held here: ${stranded.map(describeLanguageCount).join("; ")}.`
      );
    }

    return stranded.map(({ language }) => language);
  }

  const picked = await askMultiSelect(
    "Which languages should be removed?",
    stranded.map((entry) => ({ title: describeLanguageCount(entry), value: entry.language }))
  );

  if (picked.length === 0 && !hasLanguageLeftovers(census)) {
    cancel("No language was picked, so nothing was changed.");
  }

  return picked;
}

async function readPlan(migration: Migration, config: LanguageRemovalConfig): Promise<LanguageRemovalPlan> {
  const input = await readLanguageRemovalInput(migration.read, config);

  if (!input) {
    fail(`Could not read "${migration.dataset}", so nothing was exported or deleted.`);
  }

  return planLanguageRemoval(input, config);
}

/** Translate with AI's scratch documents in the removed languages: kept apart from the plan the trim shares. */
async function readAiCleanup(migration: Migration, removed: readonly string[]): Promise<AiResultCleanup> {
  return removed.length > 0
    ? planAiResultCleanup(await migration.fetch<AiResultDocument[]>(AI_RESULTS_QUERY), removed)
    : { deleteIds: [] };
}

function backupPath(dataset: string): string {
  const backupsDir = join(process.cwd(), "backups");

  if (!existsSync(backupsDir)) {
    mkdirSync(backupsDir, { recursive: true });
  }

  return join(backupsDir, `${dataset}-pre-remove-language-${formatExportTimestamp(new Date())}.tar.gz`);
}

/** Versions first (nothing references one), then one transaction for every delete and link, then the text cleanups. */
async function write(migration: Migration, plan: LanguageRemovalPlan, ai: AiResultCleanup): Promise<void> {
  const { discards, transaction, patches } = languageRemovalMutations(plan);

  for (const batch of discards) {
    await migration.client.action(batch);
  }

  if (transaction.length > 0) {
    await migration.client.mutate(transaction, { visibility: "async" });
  }

  await commitInBatches(migration.client, patches.flat());

  if (!isEmptyCleanup(ai)) {
    await migration.client.mutate(aiResultCleanupMutations(ai), { visibility: "async" });
  }
}

async function main() {
  printHeader("🌐", "Remove a language", [
    "Deletes a language LOCALES no longer configures: every copy of its documents, drafts and release versions",
    "included, its translation links, and its text on shared documents and assets. Configured languages stay.",
    "It exports the dataset first, and refuses before exporting anything Sanity would refuse to write.",
  ]);

  if (options.dryRun) {
    printDryRunNotice();
  }

  const requested = checkedLanguages(options.language ?? []);
  const migration = await openMigration(options, "Which dataset should be cleaned?");
  const liveError = liveTargetError({
    target: migration.dataset,
    liveDataset: migration.liveDataset,
    mode: "purge",
    allowLiveTarget: options.allowLiveTarget,
  });

  // The .env dataset is the live site, so an unattended delete names it, before anything is read.
  if (liveError && options.yes && !options.dryRun) {
    fail(liveError, `Project: ${migration.projectId}`, "Nothing was read or changed.");
  }

  const removed = requested.length > 0 ? requested : await chooseLanguages(migration);
  const config: LanguageRemovalConfig = { ...BASE_CONFIG, removed };
  const plan = await readPlan(migration, config);
  const ai = await readAiCleanup(migration, removed);
  const refusals = refusalReasons(plan);

  printSummary([
    { label: "Project", value: migration.projectId },
    { label: "Dataset", value: migration.dataset },
    { label: "Removing", value: removed.length > 0 ? removed.join(", ") : "no language; only text left behind" },
    { label: "Keeping", value: LOCALE_IDS.join(", ") },
    { label: "Backup", value: "an export to ./backups before anything is deleted" },
  ]);

  for (const line of [...formatLanguageRemovalPlan(plan), ...describeAiResultCleanup(ai)]) {
    console.log(line);
  }

  if (refusals.length > 0) {
    fail("Sanity would refuse these writes, so nothing was exported or deleted.", ...refusals);
  }

  if (isEmptyPlan(plan) && isEmptyCleanup(ai)) {
    const what = removed.length > 0 ? removed.join(", ") : "an unconfigured language";

    printDone(`Nothing to change: no document, link or text in ${what} is left in "${migration.dataset}".`);
    return;
  }

  if (liveError && options.dryRun) {
    console.warn(`⚠️  ${liveError}\n`);
  }

  if (options.dryRun) {
    finishDryRun();
  }

  if (migration.interactive) {
    const what =
      plan.deleteIds.length > 0
        ? `permanently delete ${plan.deleteIds.length} document copies and clean what is listed above`
        : "clean the text listed above";

    await confirmOrCancel(`⚠️  DESTRUCTIVE: ${what}, in "${migration.dataset}" (project ${migration.projectId})?`);
  }

  if (liveError && migration.interactive) {
    const typed = await askText(`"${migration.dataset}" is the live dataset in .env. Type its name to confirm`, {
      required: true,
    });

    if (typed !== migration.dataset) {
      cancel("The name did not match, so nothing was exported or deleted.");
    }
  }

  const exportPath = backupPath(migration.dataset);

  printStep("💾", `Exporting "${migration.dataset}" first… (${exportPath})`);

  try {
    runSanityCommand(buildExportArgs(migration.dataset, exportPath), "Pre-removal export");
  } catch (error) {
    fail("Could not export the dataset, so nothing was deleted.", errorText(error));
  }

  // What was confirmed is a snapshot: re-plan from fresh reads and stop if anything nobody saw would be written.
  const fresh = await readPlan(migration, config);
  const freshAi = await readAiCleanup(migration, removed);
  const growth = planGrowth(plan, fresh);
  const freshRefusals = refusalReasons(fresh);

  if (growth.length > 0 || freshRefusals.length > 0) {
    fail(
      "The dataset changed since the plan was shown, so nothing was deleted. Run this again to see the new plan.",
      ...growth.slice(0, 10),
      ...freshRefusals
    );
  }

  printStep("🗑️", `Removing from "${migration.dataset}"…`);

  try {
    await write(migration, fresh, freshAi);
  } catch (error) {
    fail(
      "The removal failed partway.",
      errorText(error),
      "Running this again finishes it, or restore the backup:",
      `npm run sanity:dataset-import -- --file ${exportPath} --dataset ${migration.dataset} --replace`
    );
  }

  printDone(
    `Removed ${removed.length > 0 ? removed.join(", ") : "the text left behind"} from "${migration.dataset}".`,
    `Backup: ${exportPath}. If llms.txt listed these pages, regenerate it from the Agents tab in Settings.`
  );
}

main().catch((error) => {
  fail("Unexpected error.", error instanceof Error ? (error.stack ?? error.message) : String(error));
});

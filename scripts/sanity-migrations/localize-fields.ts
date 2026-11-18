#!/usr/bin/env node

// Converts fields a shared type translates in place (`LOCALIZED_FIELDS`) from a plain string, written before they were
// translated, to `{ <default>: "..." }`. Idempotent. See docs/features/internationalization.md

import { Command } from "commander";
import { LOCALIZED_FIELDS } from "../../sanity/constants";
import { DEFAULT_LOCALE } from "../../sanity/i18n";
import {
  confirmOrCancel,
  fail,
  finishDryRun,
  printDone,
  printDryRunNotice,
  printHeader,
  printStep,
  printSummary,
} from "../lib/cli";
import type { RawDocument } from "../trim-features/language-removal";
import { commitInBatches, failWrite, guardedSet, listedRows, openMigration, printList, readReleases } from "./lib/client";
import { buildLocalizableDocumentsQuery, planFieldLocalization } from "./lib/localize";
import { partitionLocked } from "./lib/releases";

const program = new Command();

program
  .name("migrate-localize-fields")
  .description("Convert plain-string LOCALIZED_FIELDS to the per-language object")
  .option("--dataset <name>", "Dataset to migrate (defaults to a picker, or the .env dataset with --yes or --dry-run)")
  .option("--dry-run", "Show the plan and exit without prompting or writing", false)
  .option("-y, --yes", "Skip the prompts and write", false);

program.parse();

const options = program.opts<{ dataset?: string; dryRun: boolean; yes: boolean }>();

async function main() {
  const fields = Object.entries<readonly string[]>(LOCALIZED_FIELDS).flatMap(([type, names]) =>
    names.map((name) => `${type}.${name}`)
  );

  printHeader("🌐", "Localize shared fields", [
    `Converts plain-string ${fields.join(", ") || "localized fields"} to { ${DEFAULT_LOCALE}: "..." }, every copy included.`,
    "The Studio edits them per language, and shows a plain string written before as an invalid value.",
  ]);

  if (options.dryRun) {
    printDryRunNotice();
  }

  if (fields.length === 0) {
    printDone("Nothing to do: LOCALIZED_FIELDS in sanity/constants.ts lists no field.");
    return;
  }

  const migration = await openMigration(options, "Which dataset should be migrated?");
  const [documents, releases] = await Promise.all([
    migration.fetch<RawDocument[]>(buildLocalizableDocumentsQuery(LOCALIZED_FIELDS), { types: Object.keys(LOCALIZED_FIELDS) }),
    readReleases(migration),
  ]);
  const { open: patches, locked } = partitionLocked(planFieldLocalization(documents, LOCALIZED_FIELDS, DEFAULT_LOCALE), releases);

  printSummary([
    { label: "Project", value: migration.projectId },
    { label: "Dataset", value: migration.dataset },
    { label: "To localize", value: `${patches.length} document copies` },
    ...listedRows(patches, ({ id, set }) => ({
      label: id,
      value: Object.entries(set)
        .map(([field, value]) => `${field}: ${JSON.stringify(value)}`)
        .join(", "),
    })),
  ]);

  printList(
    "⚠️  Left as they are:",
    locked.map(({ id, reason }) => `${id}: ${reason}`)
  );

  if (patches.length === 0) {
    printDone("Nothing to do: every localized field already stores its languages.");
    return;
  }

  if (options.dryRun) {
    finishDryRun();
  }

  if (migration.interactive) {
    await confirmOrCancel(`Localize ${patches.length} document copies in "${migration.dataset}"?`);
  }

  printStep("✍️", `Localizing "${migration.dataset}"…`);

  try {
    await commitInBatches(
      migration.client,
      patches.map(({ id, rev, set }) => guardedSet(id, rev, set))
    );
  } catch (error) {
    failWrite(error);
  }

  printDone(`Localized ${patches.length} document copies.`);
}

main().catch((error) => {
  fail("Unexpected error.", error instanceof Error ? (error.stack ?? error.message) : String(error));
});

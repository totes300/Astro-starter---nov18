#!/usr/bin/env node

// Converts plain-string asset text to `{ <default>: "..." }`, the shape the media library stores once more than one
// locale is configured. Idempotent. See docs/features/internationalization.md

import { Command } from "commander";
import { DEFAULT_LOCALE, IS_I18N_ENABLED } from "../../sanity/i18n";
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
import { LOCALIZED_ASSET_FIELDS, type RawDocument } from "../trim-features/language-removal";
import { commitInBatches, failWrite, guardedSet, listedRows, openMigration } from "./lib/client";
import { buildLocalizableAssetsQuery, planAssetLocalization } from "./lib/localize";

const program = new Command();

program
  .name("migrate-asset-fields")
  .description("Convert plain-string asset text to the per-language object")
  .option("--dataset <name>", "Dataset to migrate (defaults to a picker, or the .env dataset with --yes or --dry-run)")
  .option("--dry-run", "Show the plan and exit without prompting or writing", false)
  .option("-y, --yes", "Skip the prompts and write", false);

program.parse();

const options = program.opts<{ dataset?: string; dryRun: boolean; yes: boolean }>();

async function main() {
  printHeader("🖼️", "Localize asset text", [
    `Converts plain-string ${LOCALIZED_ASSET_FIELDS.join(", ")} on assets to { ${DEFAULT_LOCALE}: "..." }.`,
    "With more than one locale the media library edits them per language; the site reads both shapes.",
  ]);

  if (options.dryRun) {
    printDryRunNotice();
  }

  // With one locale the media library stores and edits plain strings, so converting would fight it.
  if (!IS_I18N_ENABLED) {
    printDone("Nothing to do: one locale is configured, and the media library keeps asset text as plain strings.");
    return;
  }

  const migration = await openMigration(options, "Which dataset should be migrated?");
  const assets = await migration.fetch<RawDocument[]>(buildLocalizableAssetsQuery());
  const patches = planAssetLocalization(assets, DEFAULT_LOCALE);

  printSummary([
    { label: "Project", value: migration.projectId },
    { label: "Dataset", value: migration.dataset },
    { label: "To localize", value: `${patches.length} assets` },
    ...listedRows(patches, ({ id, fields }) => ({ label: id, value: fields.join(", ") })),
  ]);

  if (patches.length === 0) {
    printDone("Nothing to do: no asset stores its text as a plain string.");
    return;
  }

  if (options.dryRun) {
    finishDryRun();
  }

  if (migration.interactive) {
    await confirmOrCancel(`Localize the text on ${patches.length} assets in "${migration.dataset}"?`);
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

  printDone(`Localized the text on ${patches.length} assets.`);
}

main().catch((error) => {
  fail("Unexpected error.", error instanceof Error ? (error.stack ?? error.message) : String(error));
});

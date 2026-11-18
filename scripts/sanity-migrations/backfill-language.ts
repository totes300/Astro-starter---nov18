#!/usr/bin/env node

// Sets `language` on translated documents with none, which the translation plugin will not translate, or an empty one,
// which the site hides. Idempotent. See docs/features/internationalization.md

import { Command } from "commander";
import { I18N_DOCUMENT_TYPES } from "../../sanity/constants";
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
import { buildTranslatedDocumentsQuery } from "../trim-features/language-removal";
import { commitInBatches, failWrite, guardedSet, listedRows, openMigration, printList, readReleases } from "./lib/client";
import { type LanguageCopy, MISSING_LANGUAGE_QUERY, planLanguageBackfill } from "./lib/language";

const program = new Command();

program
  .name("migrate-backfill-language")
  .description("Set the language on translated documents that have none")
  .option("--dataset <name>", "Dataset to backfill (defaults to a picker, or the .env dataset with --yes or --dry-run)")
  .option("--dry-run", "Show the plan and exit without prompting or writing", false)
  .option("-y, --yes", "Skip the prompts and write", false);

program.parse();

const options = program.opts<{ dataset?: string; dryRun: boolean; yes: boolean }>();

async function main() {
  printHeader("🌐", "Language backfill", [
    "Sets `language` on translated documents that have none, or an empty one, drafts and release versions included.",
    `A copy takes the language its other copies state, else "${DEFAULT_LOCALE}". The site hides an empty one until then.`,
  ]);

  if (options.dryRun) {
    printDryRunNotice();
  }

  const migration = await openMigration(options, "Which dataset should be backfilled?");
  const [missing, copies, releases] = await Promise.all([
    migration.fetch<LanguageCopy[]>(MISSING_LANGUAGE_QUERY, { types: I18N_DOCUMENT_TYPES }),
    migration.fetch<LanguageCopy[]>(buildTranslatedDocumentsQuery(I18N_DOCUMENT_TYPES)),
    readReleases(migration),
  ]);
  const { patches, skipped } = planLanguageBackfill(missing, copies, DEFAULT_LOCALE, releases);

  printSummary([
    { label: "Project", value: migration.projectId },
    { label: "Dataset", value: migration.dataset },
    { label: "To backfill", value: `${patches.length} document copies` },
    ...listedRows(patches, ({ id, type, uri, language, inherited }) => ({
      label: id,
      value: `${type}${uri ? ` ${uri}` : ""} → "${language}"${inherited ? " (from its other copies)" : ""}`,
    })),
  ]);

  printList(
    "⚠️  Left as they are:",
    skipped.map(({ id, type, reason }) => `${id} (${type}): ${reason}`)
  );

  if (patches.length === 0) {
    printDone(
      skipped.length > 0
        ? "Nothing this can write; the copies above need a person."
        : "Nothing to do: every translated document has a language."
    );
    return;
  }

  if (options.dryRun) {
    finishDryRun();
  }

  if (migration.interactive) {
    await confirmOrCancel(`Set the language on ${patches.length} document copies in "${migration.dataset}"?`);
  }

  printStep("✍️", `Backfilling "${migration.dataset}"…`);

  try {
    await commitInBatches(
      migration.client,
      patches.map(({ id, rev, language }) => guardedSet(id, rev, { language }))
    );
  } catch (error) {
    failWrite(error);
  }

  printDone(`Set the language on ${patches.length} document copies.`);
}

main().catch((error) => {
  fail("Unexpected error.", error instanceof Error ? (error.stack ?? error.message) : String(error));
});

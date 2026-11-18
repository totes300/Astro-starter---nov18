#!/usr/bin/env node

// Prepares a dataset for a language just added to LOCALES: collision check, language backfill, and linked draft
// translations of every per-language singleton. Idempotent. See docs/features/internationalization.md

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { I18N_DOCUMENT_TYPES, SINGLETON_IDS, TRANSLATION_EXCLUDED_FIELDS } from "../../sanity/constants";
import { DEFAULT_LOCALE, getLocaleTitle, isLocale, LOCALE_IDS } from "../../sanity/i18n";
import { collectReferences, TRANSLATION_VARIANTS_QUERY, type TranslationGroup } from "../../sanity/translation-references";
import {
  askSelect,
  confirmOrCancel,
  fail,
  finishDryRun,
  printDone,
  printDryRunNotice,
  printHeader,
  printStep,
  printSummary,
} from "../lib/cli";
import {
  buildTranslatedDocumentsQuery,
  buildTranslationMetadataQuery,
  type RawDocument,
} from "../trim-features/language-removal";
import { commitInBatches, failWrite, guardedSet, listedRows, openMigration, printList, readReleases } from "./lib/client";
import {
  findPrefixCollisions,
  type LanguageCopy,
  MISSING_LANGUAGE_QUERY,
  planLanguageBackfill,
  planSingletonTranslations,
  stubMutations,
} from "./lib/language";

const program = new Command();

program
  .name("add-language")
  .description("Prepare a dataset for a language added to LOCALES")
  .option("--language <id>", "Language to prepare (defaults to a picker over the configured ones)")
  .option("--dataset <name>", "Dataset to prepare (defaults to a picker, or the .env dataset with --yes or --dry-run)")
  .option("--dry-run", "Show the plan and exit without prompting or writing", false)
  .option("-y, --yes", "Skip the prompts and write (needs --language)", false);

program.parse();

const options = program.opts<{ language?: string; dataset?: string; dryRun: boolean; yes: boolean }>();

/** The app's dictionary folder, with or without a `src/` root; only the file's presence is read, never its code. */
const DICTIONARY_DIRS = ["src/features/i18n/dictionaries", "features/i18n/dictionaries"];

function hasDictionary(language: string): boolean {
  return DICTIONARY_DIRS.some((dir) => existsSync(join(process.cwd(), dir, `${language}.ts`)));
}

/** Config first, then data: the Studio and the routes must already know the language this run writes. */
async function resolveLanguage(interactive: boolean): Promise<string> {
  // Typed wide: with one locale the filter would narrow to `never[]`.
  const candidates: string[] = LOCALE_IDS.filter((id) => id !== DEFAULT_LOCALE);

  if (options.language) {
    if (options.language === DEFAULT_LOCALE) {
      fail(`"${options.language}" is the default locale; it needs no preparing.`);
    }

    if (!isLocale(options.language)) {
      fail(`"${options.language}" is not in LOCALES.`, "Add it to sanity/i18n.ts and deploy first, then run this again.");
    }

    return options.language;
  }

  if (candidates.length === 0) {
    fail("Only the default locale is configured.", "Add the new language to LOCALES in sanity/i18n.ts first.");
  }

  if (candidates.length === 1) {
    return candidates[0] as string;
  }

  if (!interactive) {
    fail(`Name the language with --language: ${candidates.join(", ")} are configured.`);
  }

  return askSelect(
    "Which language should be prepared?",
    candidates.map((id) => ({ title: `${getLocaleTitle(id)} (${id})`, value: id }))
  );
}

async function main() {
  printHeader("🌐", "Add a language", [
    "Checks no document already sits under the new prefix, backfills missing languages, and creates a draft",
    "translation of each singleton kept once per language, such as the Site and the Homepage, for editors to translate and publish.",
  ]);

  if (options.dryRun) {
    printDryRunNotice();
  }

  const migration = await openMigration(options, "Which dataset should be prepared?");
  const language = await resolveLanguage(migration.interactive);
  const title = getLocaleTitle(language);
  const singletonIds = Object.values(SINGLETON_IDS).flatMap((id) => [id, `drafts.${id}`]);

  const [routed, missing, copies, releases, singletons, metadata] = await Promise.all([
    migration.fetch<LanguageCopy[]>(`*[defined(uri.current)]{ _id, _type, language, "uri": uri.current }`),
    migration.fetch<LanguageCopy[]>(MISSING_LANGUAGE_QUERY, { types: I18N_DOCUMENT_TYPES }),
    migration.fetch<LanguageCopy[]>(buildTranslatedDocumentsQuery(I18N_DOCUMENT_TYPES)),
    readReleases(migration),
    migration.fetch<RawDocument[]>("*[_id in $ids]", { ids: singletonIds }),
    migration.fetch<RawDocument[]>(buildTranslationMetadataQuery()),
  ]);

  const collisions = findPrefixCollisions(routed, language, DEFAULT_LOCALE);

  if (collisions.length > 0) {
    fail(
      `${collisions.length} document copies already sit under /${language} in another language, and would route as ${title}:`,
      ...collisions.map(({ _id, _type, uri }) => `${_id} (${_type}) ${uri}`),
      "Move them to another path (and add redirects), then run this again."
    );
  }

  const backfill = planLanguageBackfill(missing, copies, DEFAULT_LOCALE, releases);
  const references = [...new Set(singletons.flatMap((singleton) => collectReferences(singleton).map(({ ref }) => ref)))];
  const groups =
    references.length > 0
      ? await migration.fetch<TranslationGroup[]>(TRANSLATION_VARIANTS_QUERY, { ids: references }, "published")
      : [];
  const plan = planSingletonTranslations({
    singletons,
    i18nTypes: I18N_DOCUMENT_TYPES,
    metadata,
    copies,
    locale: language,
    defaultLocale: DEFAULT_LOCALE,
    excludedFields: TRANSLATION_EXCLUDED_FIELDS,
    groups,
  });

  printSummary([
    { label: "Project", value: migration.projectId },
    { label: "Dataset", value: migration.dataset },
    { label: "Language", value: `${title} (${language})` },
    { label: "URI collisions", value: "none" },
    { label: "Language backfill", value: `${backfill.patches.length} document copies` },
    ...listedRows(plan.stubs, ({ sourceId, uri }) => ({ label: `Translate ${sourceId}`, value: uri ?? "a draft, no URI" })),
    ...plan.translated.map((id) => ({ label: `Skip ${id}`, value: "already translated" })),
  ]);

  printList(
    "⚠️  Left as they are:",
    [...backfill.skipped, ...plan.skipped].map(({ id, type, reason }) => `${id} (${type}): ${reason}`)
  );

  if (!hasDictionary(language)) {
    console.log(`⚠️  No UI dictionary for "${language}" (i18n/dictionaries/${language}.ts): the site's own copy stays in`);
    console.log(`   ${getLocaleTitle(DEFAULT_LOCALE)}, and \`npm test\` fails until it exists.\n`);
  }

  if (backfill.patches.length + plan.stubs.length === 0) {
    printDone(`Nothing to write: the dataset is ready for ${title}.`);
    return;
  }

  if (options.dryRun) {
    finishDryRun();
  }

  if (migration.interactive) {
    await confirmOrCancel(
      `Backfill ${backfill.patches.length} document copies and create ${plan.stubs.length} draft translations in "${migration.dataset}"?`
    );
  }

  printStep("✍️", `Preparing "${migration.dataset}" for ${title}…`);

  try {
    await commitInBatches(
      migration.client,
      backfill.patches.map(({ id, rev, language: value }) => guardedSet(id, rev, { language: value }))
    );

    if (plan.stubs.length > 0) {
      await migration.client.mutate(
        plan.stubs.flatMap((stub) => stubMutations(stub)),
        { visibility: "async" }
      );
    }
  } catch (error) {
    failWrite(error);
  }

  printDone(
    `Created ${plan.stubs.length} draft translations and backfilled ${backfill.patches.length} document copies.`,
    "Next: translate and publish the drafts, the Site first (until then the language shows the default Site's header and footer), then run the alt text and agent Markdown backfills in Settings > Agents."
  );
}

main().catch((error) => {
  fail("Unexpected error.", error instanceof Error ? (error.stack ?? error.message) : String(error));
});

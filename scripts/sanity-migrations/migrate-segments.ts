#!/usr/bin/env node

// Moves every section document to its language's current word after `SECTION_SEGMENTS` changes, and adds the 301s
// that keep the old URLs working. Idempotent. See docs/features/internationalization.md ("Section segments")

import type { Mutation } from "@sanity/client";
import { Command } from "commander";
import { SANITY_SINGLETON_SITE_SETTINGS_ID } from "../../sanity/constants";
import { DEFAULT_LOCALE } from "../../sanity/i18n";
import { SECTION_DOCUMENT_TYPES } from "../../sanity/sections";
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
import { commitInBatches, failWrite, guardedSet, listedRows, openMigration, printList, readReleases } from "./lib/client";
import type { LanguageCopy } from "./lib/language";
import { planSegmentMigration, type SettingsCopy, type SettingsPatch } from "./lib/segments";

const program = new Command();

program
  .name("migrate-segments")
  .description("Move section URIs to the words in SECTION_SEGMENTS and redirect the old URLs")
  .option("--dataset <name>", "Dataset to migrate (defaults to a picker, or the .env dataset with --yes or --dry-run)")
  .option("--dry-run", "Show the plan and exit without prompting or writing", false)
  .option("-y, --yes", "Skip the prompts and write", false);

program.parse();

const options = program.opts<{ dataset?: string; dryRun: boolean; yes: boolean }>();

const SETTINGS_QUERY = `*[_id == $id || _id == $draft || _id in path($versions)]{
  _id,
  _rev,
  "redirects": redirects[]{ _key, "ref": _ref, "from": coalesce(from, @->from), "to": coalesce(to, @->to) }
}`;

/** One patch per settings copy: re-aim what pointed at a moved URL, then append the new redirects. */
function settingsMutation({ id, rev, add, retarget }: SettingsPatch): Mutation {
  const set = Object.fromEntries(retarget.map(({ key, to }) => [`redirects[_key=="${key}"].to`, to]));

  return {
    patch: {
      id,
      ...(rev ? { ifRevisionID: rev } : {}),
      ...(retarget.length > 0 ? { set } : {}),
      ...(add.length > 0 ? { setIfMissing: { redirects: [] }, insert: { after: "redirects[-1]", items: add } } : {}),
    },
  };
}

async function main() {
  printHeader("🌐", "Section segments", [
    "Moves every section document, its nested types included, to its language's word in sanity/sections.ts,",
    "and adds a 301 from each old public URL to the new one under Settings > Redirects.",
  ]);

  if (options.dryRun) {
    printDryRunNotice();
  }

  if (SECTION_DOCUMENT_TYPES.length === 0) {
    printDone("Nothing to move: sanity/sections.ts declares no section.");
    return;
  }

  const migration = await openMigration(options, "Which dataset should be migrated?");
  const [documents, holders, settings, releases] = await Promise.all([
    migration.fetch<LanguageCopy[]>(
      `*[_type in $types && defined(uri.current)]{ _id, _type, _rev, language, "uri": uri.current }`,
      { types: SECTION_DOCUMENT_TYPES }
    ),
    migration.fetch<LanguageCopy[]>(`*[defined(uri.current)]{ _id, _type, "uri": uri.current }`),
    migration.fetch<SettingsCopy[]>(SETTINGS_QUERY, {
      id: SANITY_SINGLETON_SITE_SETTINGS_ID,
      draft: `drafts.${SANITY_SINGLETON_SITE_SETTINGS_ID}`,
      versions: `versions.*.${SANITY_SINGLETON_SITE_SETTINGS_ID}`,
    }),
    readReleases(migration),
  ]);

  const plan = planSegmentMigration({
    documents,
    holders,
    settings,
    settingsId: SANITY_SINGLETON_SITE_SETTINGS_ID,
    defaultLocale: DEFAULT_LOCALE,
    releases,
  });
  const hasSettings = settings.some(({ _id }) => _id === SANITY_SINGLETON_SITE_SETTINGS_ID);
  const retargeted = plan.settings.find(({ id }) => id === SANITY_SINGLETON_SITE_SETTINGS_ID)?.retarget ?? [];

  printSummary([
    { label: "Project", value: migration.projectId },
    { label: "Dataset", value: migration.dataset },
    { label: "URIs to move", value: String(plan.changes.length) },
    ...listedRows(plan.changes, ({ id, from, to }) => ({ label: id, value: `${from} → ${to}` })),
    { label: "New redirects", value: String(plan.redirects.length) },
    { label: "Redirects re-aimed", value: String(retargeted.length) },
  ]);

  printList(
    "⚠️  Not under a section word, so left alone (fix these by hand):",
    plan.unplaced.map(({ _id, _type, uri }) => `${_id} (${_type}) ${uri}`)
  );
  printList(
    "⚠️  Left as they are:",
    plan.locked.map(({ id, reason }) => `${id}: ${reason}`)
  );
  printList(
    "⚠️  There is no published Settings document, so these old URLs get no redirect:",
    hasSettings ? [] : plan.redirects.map(({ from, to }) => `${from} → ${to}`)
  );
  printList(
    "⚠️  Stored as references, so re-aim these redirects by hand:",
    plan.manual.map(({ from, to }) => `${from} → ${to}`)
  );

  if (plan.collisions.length > 0) {
    fail(
      "Some moves would land where something already answers, so nothing was written:",
      ...plan.collisions.map(({ id, reason }) => `${id}: ${reason}`),
      "Move or remove those first, then run this again."
    );
  }

  if (plan.changes.length + plan.settings.length === 0) {
    printDone("Nothing to move: every section document uses its language's current word.");
    return;
  }

  if (options.dryRun) {
    finishDryRun();
  }

  if (migration.interactive) {
    await confirmOrCancel(
      `Move ${plan.changes.length} URIs and add ${plan.redirects.length} redirects in "${migration.dataset}"?`
    );
  }

  printStep("✍️", `Moving URIs in "${migration.dataset}"…`);

  // One transaction, so a URI never moves without the redirect that keeps its old URL working.
  const mutations = [
    ...plan.changes.map(({ id, rev, to }) => guardedSet(id, rev, { "uri.current": to })),
    ...plan.settings.map(settingsMutation),
  ];

  try {
    await commitInBatches(migration.client, mutations, mutations.length);
  } catch (error) {
    failWrite(error);
  }

  printDone(
    `Moved ${plan.changes.length} URIs and added ${hasSettings ? plan.redirects.length : 0} redirects.`,
    "Redirects are read when the app is built: redeploy it to make them live."
  );
}

main().catch((error) => {
  fail("Unexpected error.", error instanceof Error ? (error.stack ?? error.message) : String(error));
});

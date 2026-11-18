// The dataset a migration works on, and the raw-perspective edit client it reads and writes through.
// Raw, so drafts and release versions come back as documents of their own and each copy is written.

import type { Mutation, SanityClient } from "@sanity/client";
import { fail } from "../../lib/cli";
import { createEditClient } from "../../lib/sanity-client";
import { askDataset, loadDatasets } from "../../sanity-dataset/dataset-picker";
import { getSanityEnv } from "../../sanity-dataset/lib";
import type { QueryReader } from "../../trim-features/language-removal";
import { buildReleasesQuery, type Release } from "./releases";

export type MigrationFlags = { dataset?: string; dryRun: boolean; yes: boolean };

export type Migration = {
  projectId: string;
  dataset: string;
  /** The `.env` dataset: the live site. */
  liveDataset: string;
  interactive: boolean;
  client: SanityClient;
  /** One read that fails the run with the reason, so a plan is never made from a partial dataset. */
  fetch: <T>(query: string, params?: Record<string, unknown>, perspective?: "raw" | "published") => Promise<T>;
  /** The same read for the shared planner, which takes `undefined` as "could not read". */
  read: QueryReader;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `--dataset`, else the picker when interactive, else the `.env` dataset. Writes nothing. */
export async function openMigration(flags: MigrationFlags, question: string): Promise<Migration> {
  let env: { SANITY_PROJECT_ID: string; SANITY_DATASET: string };

  try {
    env = getSanityEnv(process.env);
  } catch (error) {
    fail(
      "Failed to load Sanity environment variables.",
      "Set SANITY_PROJECT_ID and SANITY_DATASET, or the app's public Sanity pair, in `.env`.",
      errorText(error)
    );
  }

  const interactive = !flags.yes && !flags.dryRun;
  const dataset =
    flags.dataset ??
    (interactive ? await askDataset(question, { datasets: loadDatasets(), current: env.SANITY_DATASET }) : env.SANITY_DATASET);

  let client: SanityClient;

  try {
    client = createEditClient({ dataset });
  } catch (error) {
    fail(
      "SANITY_API_EDIT_TOKEN is not set, so nothing was read or written.",
      "Migrations read drafts and release versions, which only a token sees, and write with the same token.",
      errorText(error)
    );
  }

  const fetch = async <T>(query: string, params: Record<string, unknown> = {}, perspective: "raw" | "published" = "raw") => {
    try {
      return await client.fetch<T>(query, params, { perspective });
    } catch (error) {
      fail(`Could not read "${dataset}", so nothing was written.`, errorText(error));
    }
  };

  const read: QueryReader = async (query) => {
    try {
      return await client.fetch(query);
    } catch (error) {
      console.error(`   ${errorText(error)}`);
      return undefined;
    }
  };

  return { projectId: env.SANITY_PROJECT_ID, dataset, liveDataset: env.SANITY_DATASET, interactive, client, fetch, read };
}

export function readReleases(migration: Migration): Promise<Release[]> {
  return migration.fetch<Release[]>(buildReleasesQuery());
}

/** Patches split into transactions of `size`, each committed whole; returns how many were written. */
export async function commitInBatches(client: SanityClient, mutations: readonly Mutation[], size = 100): Promise<number> {
  const step = Math.max(1, size);
  let written = 0;

  for (let index = 0; index < mutations.length; index += step) {
    const batch = mutations.slice(index, index + step);

    await client.mutate(batch, { visibility: "async" });
    written += batch.length;
  }

  return written;
}

/** A guarded `set`: a copy edited since it was read fails its batch instead of losing the edit. */
export function guardedSet(id: string, rev: string | undefined, set: Record<string, unknown>): Mutation {
  return { patch: { id, ...(rev ? { ifRevisionID: rev } : {}), set } };
}

const LISTED = 20;

/** A heading and its items, the first twenty shown; nothing at all when there are none. */
export function printList(heading: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }

  console.log(`${heading}\n`);

  for (const item of items.slice(0, LISTED)) {
    console.log(`     ${item}`);
  }

  if (items.length > LISTED) {
    console.log(`     … and ${items.length - LISTED} more`);
  }

  console.log("");
}

/** Summary rows for the first twenty items, then one row counting the rest. */
export function listedRows<T>(items: readonly T[], row: (item: T) => { label?: string; value: string }) {
  const rows = items.slice(0, LISTED).map(row);

  return items.length > LISTED ? [...rows, { value: `… and ${items.length - LISTED} more` }] : rows;
}

/** The shared failure for a write that stopped partway: every migration here is idempotent, so a rerun finishes it. */
export function failWrite(error: unknown, ...details: string[]): never {
  fail("The write failed partway.", errorText(error), ...details, "Every migration here is idempotent: run it again to finish.");
}

#!/usr/bin/env node

// `npm run sanity:schema-check`: exits 1 when the schema deployed to Sanity differs from sanity-schema.json.
// Reads with the view token and writes nothing, so a deploy step can run it. Details: ./README.md

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@sanity/client";
import { AiTranslationDeployedSchemaQuery } from "~/features/agents/query";
import { fail, printDone, printHeader, printSummary } from "../lib/cli";
import { getSanityEnv } from "../sanity-dataset/lib";
import { compareSchemas, EXTRACT_FILE, parseDeployedSchema } from "./lib";

const DEPLOY_HINT = "Run npm run sanity:schema-deploy from the commit you deploy, then run this check again.";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function main() {
  printHeader("🧭", "Schema check", [
    `Compares the schema deployed to Sanity, which Agent Actions read, with ${EXTRACT_FILE}. Nothing is written.`,
  ]);

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

  const token = process.env.SANITY_API_VIEW_TOKEN;

  if (!token) {
    fail(
      "SANITY_API_VIEW_TOKEN is not set, so nothing was read.",
      "The deployed schema is a private document a token must read."
    );
  }

  let local: unknown;

  try {
    local = JSON.parse(readFileSync(join(process.cwd(), EXTRACT_FILE), "utf8"));
  } catch (error) {
    fail(`Could not read ${EXTRACT_FILE}.`, "Run npm run sanity:typegen to write it.", errorText(error));
  }

  if (!Array.isArray(local)) {
    fail(`${EXTRACT_FILE} is not a schema extract.`, "Run npm run sanity:typegen to write it again.");
  }

  const dataset = env.SANITY_DATASET;
  const client = createClient({
    projectId: env.SANITY_PROJECT_ID,
    dataset,
    apiVersion: "2025-02-19",
    token,
    useCdn: false,
    perspective: "raw",
  });

  let stored: { _updatedAt?: string; schema?: unknown } | null;

  try {
    stored = await client.fetch(AiTranslationDeployedSchemaQuery);
  } catch (error) {
    fail(`Could not read the deployed schema from "${dataset}".`, errorText(error));
  }

  if (stored?.schema === undefined || stored.schema === null) {
    fail(`No schema is deployed to "${dataset}", so Translate with AI refuses every run.`, DEPLOY_HINT);
  }

  const deployed = parseDeployedSchema(stored.schema);

  if (!deployed) {
    fail(`The schema deployed to "${dataset}" could not be read.`, DEPLOY_HINT);
  }

  const { drift, pausesTranslation, documentTypes } = compareSchemas({ deployed, local });

  printSummary([
    { label: "Dataset", value: dataset },
    { label: "Deployed", value: stored._updatedAt ?? "unknown" },
    { label: "Compared", value: `${documentTypes.length} document types, field by field` },
  ]);

  if (drift.length > 0) {
    fail(
      pausesTranslation
        ? "The deployed schema differs from this code, and Translate with AI refuses every run until it is deployed."
        : "The deployed schema differs from this code.",
      ...drift,
      DEPLOY_HINT
    );
  }

  printDone("The deployed schema matches this code.");
}

main().catch((error) => {
  fail("Unexpected error.", error instanceof Error ? (error.stack ?? error.message) : String(error));
});

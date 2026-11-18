/**
 * One GROQ read under the raw perspective, printed as JSON with `null` and `0` included. `runQuery`
 * starts it through `sanity exec --with-user-token`, so it reads on the machine's `sanity login`.
 */

import { getCliClient } from "sanity/cli";

const [query, dataset, apiVersion] = process.argv.slice(2);

if (!query || !dataset || !apiVersion) {
  console.error("Usage: sanity exec raw-query.ts --with-user-token -- <query> <dataset> <api-version>");
  process.exit(1);
}

// The API defaults to `published` from 2025-02-19, which hides every draft and release version.
getCliClient({ apiVersion })
  .withConfig({ dataset, perspective: "raw" })
  .fetch(query)
  .then((result: unknown) => {
    process.stdout.write(JSON.stringify(result ?? null));
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

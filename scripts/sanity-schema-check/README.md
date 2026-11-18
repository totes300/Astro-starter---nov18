# Schema check (`scripts/sanity-schema-check/`)

Agent Actions (Translate with AI, automatic alt text) read the schema deployed to Sanity, not your code, and deploying the site never deploys it. `npm run sanity:schema-check` says whether the deployed schema still matches the code, so a forgotten `npm run sanity:schema-deploy` is found by a developer rather than by an editor.

| File | Role |
| --- | --- |
| `check.ts` | `npm run sanity:schema-check`: reads, compares, exits 0 or 1 |
| `lib.ts` | The comparison |
| `lib.test.ts` | Unit tests (`npm test`) |

## What it compares

- **The deployed schema**: the `_.schemas.default` document `npm run sanity:schema-deploy` writes, the one Agent Actions use, read with `SANITY_API_VIEW_TOKEN` from the dataset in `.env`. `SANITY_DATASET` wins over the app's public dataset variable, so `SANITY_DATASET=staging npm run sanity:schema-check` checks another dataset.
- **This code's schema**: `sanity-schema.json`, the extract `npm run sanity:typegen` writes. The translate route compares the same file, so run typegen (or `npm run check`) after a schema change before trusting either.
- **How**: every document type field by field, with the rule Translate with AI applies before a run (`schemaDrift` in `~/features/agents/translate`): a field on one side only, or one whose JSON kind changed. A document type deployed but removed here counts too. Sanity's own asset documents are skipped.

It exits 1 on any difference and says when Translate with AI is paused, which is when a translated type differs. It writes nothing.

A new section or rich text block changes no document's fields, so it passes the check: deploy the schema with it anyway.

## When to run it

Before deploying, and after a schema change once `npm run sanity:schema-deploy` has run.

The deployment docs say what each outcome means and who acts on it.

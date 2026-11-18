# Scripts

Root `package.json` exposes Sanity helpers under the `sanity:*` namespace (see `package.json`).

- **`lib/`**: The shared interactive shell every script below is built on (`cli.ts`): header, prompts, summary block, confirmation, cancel and failure exits.
- **`sanity-dataset/`**: Dataset export, import, and migration CLIs. Entry points: `npm run sanity:dataset-export`, `npm run sanity:dataset-import`, `npm run sanity:dataset-migrate`. The bundled seed is narrowed to the languages `sanity/i18n.ts` configures on import; backups restore verbatim. Details: `sanity-dataset/README.md`.
- **`sanity-migrations/`**: Language migrations, each reading and writing the raw dataset with the edit token. Entry points: `npm run sanity:add-language`, `npm run sanity:migrate-backfill-language`, `npm run sanity:migrate-localize-fields`, `npm run sanity:migrate-asset-fields`, `npm run sanity:migrate-segments`, `npm run sanity:migrate-remove-language`. Details: `sanity-migrations/README.md`.
- **`i18n-check/`**: `npm run i18n:check`, the build and tests in the locale mode `sanity/i18n.ts` does not run, in a throwaway copy of the tree. Details: `i18n-check/README.md`.
- **`sanity-schema-check/`**: `npm run sanity:schema-check`, which reads the schema deployed to Sanity with the view token and exits 1 while it differs from `sanity-schema.json`; run it before deploying or after a schema change. Details: `sanity-schema-check/README.md`.
- **`trim-features/`**: Interactive feature removal for this superset starter (code, docs, dependencies and Sanity content), a language included. Entry points: `npm run trim` (with `--status` and `--reconcile`), `npm run trim -- --dataset-only` for content an earlier trim left behind (`--language <id>` for a language), and `npm run trim:update` to take the starter's current copy. Details: `trim-features/README.md`.
- **`sanity-project-setup/`**: Interactive Sanity project bootstrap (private dataset, tokens, CORS, `.env` with a generated revalidate secret, seed content). Entry point: `npm run sanity:project-setup`. Details: `sanity-project-setup/README.md`.
- **`dependencies/`**: No command. `single-copy.test.ts` runs in `npm test` and fails when `package-lock.json` installs a second copy of `@sanity/ui` or of the `motion` packages the Studio shares.

## One shape for every script

Run any of them with no flags and you get the same flow:

1. **Header** naming the script and what it does.
2. **Questions** for whatever the flags did not already answer. Datasets come from a picker listing the project's real datasets (`sanity dataset list`), with the `.env` one first and "Other (type a name)" last; if the list cannot be read the prompt falls back to typing the name.
3. **`📋 Summary`** of exactly what is about to happen.
4. **One confirmation**, defaulting to no.
5. **Result**: `✅` on success, `👋 Cancelled.` when you decline or press Ctrl-C (exit 0), `❌` with the reason on failure (exit 1).

Every flag answers one question up front, so scripting stays possible:

| Flag           | Meaning                                                            |
| -------------- | ------------------------------------------------------------------ |
| `--dry-run`    | Ask nothing, print the summary, exit without touching anything     |
| `-y`, `--yes`  | Answer every prompt, for CI and scripts                            |

`npm run trim` follows the same shape, with one addition before the summary: it resolves every edit
against the tree first and aborts with the full list if any anchor no longer matches, so a drifted
repo is never left half-trimmed.

`--dry-run` and `--yes` are non-interactive, so anything the flags leave unanswered either falls back to the `.env` value or exits with an error naming the missing flag.

A destructive step never falls back to the `.env` dataset unattended: `--replace --yes` imports need `--dataset`, and `--replace` imports, `--clean`/`--replace` migrations, trim purges and `sanity:migrate-remove-language` purges into the `.env` dataset need `--allow-live-target <name>` repeating it (interactively, you type the name). Imports into a dataset that is not private ask first, or need `--allow-public` under `--yes`.

## Tests

The pure helpers in each `lib.ts` and in `lib/cli.ts` (env parsing, arg builders, validation, dataset-list parsing, summary formatting, env-file upserts, CLI output parsing) are covered by colocated `*.test.ts` files using the Node test runner. Run them with:

```bash
npm test
```

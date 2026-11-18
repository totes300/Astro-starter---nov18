# Locale mode check (`scripts/i18n-check/`)

`LOCALES` in `sanity/i18n.ts` decides whether the site runs one language or several, and most of the i18n code only runs in one of the two modes. `npm run i18n:check` proves the mode you are **not** running still builds and passes its tests.

| File | Role |
| --- | --- |
| `run.ts` | `npm run i18n:check`: the full check in a throwaway copy of the tree |
| `lib.ts` | The switch plan, the query count and the copy |
| `lib.test.ts` | Unit tests (`npm test`) |

It reads `LOCALES` as text and switches it with the toggle in `scripts/sanity-migrations/lib/locales.ts`:

- **Several locales configured**: every entry but the default is commented out (`disableLocales`).
- **One locale configured**: every commented candidate, a line like `// { id: "it", title: "Italiano", region: "IT", flag: "🇮🇹" },` inside `LOCALES`, is enabled (`enableCommentedLocales`).

An entry that shares its line, holds a comment or a template literal, or has an id that is not a language code, or a `LOCALES` that is not a literal array, stops it with the reason. A single-locale config with no candidate has no other mode: it passes without running anything and says so. Keep the language you switched off as a comment to keep testing it.

## `npm run i18n:check`

```bash
npm run i18n:check             # the check
npm run i18n:check -- --dry-run  # the plan only
```

1. Copies the working tree, uncommitted work included, to a temporary folder. Files are cloned where the file system supports it. `node_modules` and `.env` are linked, never copied; `.git`, build output, `backups/` and other env files stay out.
2. Runs `npm run sanity:typegen` as configured and counts the queries it extracted.
3. Switches `sanity/i18n.ts` in the copy and runs typegen again. A lower count fails the check: typegen drops a query it cannot evaluate without an error, so the count is the only symptom.
4. Runs `astro check`, then `npm test`.
5. Deletes the copy, whatever happened, Ctrl-C included.

Typegen reads the Sanity project id from `.env` (or your shell); it never writes to a dataset. Nothing here touches your working tree.

When the switch enables a candidate with no UI dictionary (`src/features/i18n/dictionaries/<id>.ts`), which is the normal state after a trim switched it off, the tests run with `I18N_CHECK_UNTRANSLATED=<id>`, and the dictionary coverage test expects exactly that locale to be missing.

Run it after a change to locales, queries or the schema, next to `npm test` in the configured mode.

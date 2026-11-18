# Sanity migrations (`scripts/sanity-migrations/`)

Dataset migrations for languages: preparing a dataset for one, removing one, and the data shapes
translation needs. Each follows the shared flow in `../README.md`: with no flags it asks, prints the
`📋 Summary` and confirms once; `--dry-run` prints the plan and writes nothing, and wins over `--yes`;
`--yes` writes without asking. `--dataset <name>` names the dataset; otherwise a picker asks, and
`--yes` or `--dry-run` use the `.env` one.

What they share:

- **Raw reads with the edit token.** Drafts and release versions come back as documents of their own,
  so each copy is planned and written. `SANITY_API_EDIT_TOKEN` is required even for `--dry-run`,
  because only a token sees drafts and versions.
- **Locked releases are left alone.** A version in a release that is scheduled, mid-transition or
  unreadable refuses every write, so it is listed with the reason (unschedule it, then rerun).
- **Idempotent.** A rerun after success finds nothing to do, and a rerun after a failure finishes the
  job. Every patch carries the revision it was planned from, so a document edited meanwhile fails its
  batch instead of losing the edit.
- **Host-agnostic.** They read the config in `sanity/` and the shared helpers in `scripts/`, never app
  code, and take the project id and dataset under whatever prefix the app uses (see
  `getSanityEnv` in `../sanity-dataset/lib.ts`).

| Command | What it does | When |
| --- | --- | --- |
| `npm run sanity:add-language` | Stops if any document already sits under the new language's prefix in another language. Sets a missing `language` (the backfill below). Creates linked draft translations of the per-language singletons (Site, Homepage, Blog index): `TRANSLATION_EXCLUDED_FIELDS` stripped, then moved into the language exactly as the Studio's "create translation" does (`translationPatch` in `sanity/translation-callback.ts`: URI, share-image source, references), and stamped as made (`copyRecord()`) so Translate with AI tells it from a copy an editor translated. Skips a singleton already translated, or one whose place an unlinked document already holds (link that one from Translate with AI, or delete it and run this again). Warns when the app has no UI dictionary for the language. Publishes nothing. | After adding a language to `LOCALES` and deploying. |
| `npm run sanity:migrate-backfill-language` | Sets `language` on translated documents with none, or an empty one (`MISSING_LANGUAGE_QUERY`), drafts and release versions included. A copy takes the language its other copies state, else the default; copies that disagree are listed, never guessed. | Whenever documents were written outside the Studio (imports, scripts, the API). The Studio's language warning and its "Other languages" list point here. |
| `npm run sanity:migrate-localize-fields` | Converts plain `LOCALIZED_FIELDS` (strings, and portable text arrays) (`sanity/constants.ts`) to `{ <default>: "..." }` on every copy. An empty string converts too. | Once per dataset written before those fields were translated; the Studio shows the old string as an invalid value. |
| `npm run sanity:migrate-asset-fields` | Converts plain-string asset `altText`, `title`, `description` and `creditLine` to `{ <default>: "..." }`. Does nothing with one locale configured, where the media library keeps plain strings. | When a second locale is configured; the site reads both shapes. |
| `npm run sanity:migrate-segments` | After a section's word changes in `SECTION_SEGMENTS` (`sanity/sections.ts`), moves every section document (the index, its items and nested types such as people) to its language's current word, every copy included, and adds a `301` from each old public URL to `siteSettings.redirects`, published and draft alike. An existing redirect that pointed at a moved URL is re-aimed instead of chained. Stops if a move would land where a document or a redirect already answers; lists documents with no slug under a word instead of guessing. | After renaming a word once its language has content. Redirects are read when the app is built, so redeploy the app afterwards. |
| `npm run sanity:migrate-remove-language` | Deletes a language `LOCALES` no longer configures: every copy of its documents, its translation links, and its text on shared documents and assets. See below. | After a language the project added is commented out of `LOCALES` and deployed, or to finish what a hand deletion left. |

## Removing a language

A language the starter ships is turned off with `npm run trim`, which comments out its `LOCALES`
entry, deletes its dictionary and offers this same content removal. `sanity:migrate-remove-language`
is the content half on its own, for any language `LOCALES` no longer configures. Both run one planner,
`scripts/trim-features/language-removal.ts`, which lives with the trim so `npm run trim:update`
delivers it to every project.

- **What it plans**, from the raw dataset: every copy of each document in the language; its
  translation links, deleted with their group when fewer than two remain and repaired otherwise; the
  removed languages' arms of `LOCALIZED_FIELDS` on every surviving copy; and asset text, cleared of
  the removed languages or, with one locale left, flattened to the default text. Text in another
  language `LOCALES` does not configure stays; a run that removes no language clears all of it.
- **What it refuses**, before exporting anything: the default locale, a configured one, an empty
  `language` (the backfill sets it) and anything that is not a language code; a surviving document
  that strongly references one that goes; a copy in a release that is not active.
- **What it reports and never writes**: weak references that will dangle, documents whose copies
  disagree on the language, asset text with no default version (the alt text backfill can write it
  again), and suggested `301`s for Settings > Redirects.
- **Picking the language.** `--language <id...>` names it. Without it the run lists the languages
  the dataset still holds; with none left it cleans only the text a hand deletion left. A `--yes` run
  needs `--language` while any language the site no longer serves still holds documents, translation
  links or text.
- **Export first.** It writes `./backups/<dataset>-pre-remove-language-<timestamp>.tar.gz` with the
  Sanity CLI (`sanity login`), then re-reads the dataset and stops if the plan grew since it was shown.
- **Writes.** Release versions are discarded first, then one transaction deletes the documents and
  repairs the translation links, then the text cleanups commit in batches of 100.
- **Translate with AI's scratch documents** (this command only, not the trim's purge): the removed
  languages' saved results and timeout notes are deleted, and their pending category names leave
  `aiTranslation.result.labels.all` behind its revision (`lib/ai-results.ts`), so no labels request
  writes the language back.
- **The live dataset.** A `--yes` run against the `.env` dataset needs `--allow-live-target <name>`
  repeating it, and stops before reading anything without it. Interactively you type the name.

## Files

| File | Role |
| --- | --- |
| `add-language.ts`, `backfill-language.ts`, `localize-fields.ts`, `localize-asset-fields.ts`, `migrate-segments.ts`, `remove-language.ts` | The CLIs above |
| `lib/client.ts` | The dataset question, the raw-perspective edit client, batched commits |
| `lib/language.ts` | Language backfill, prefix collisions, translation stubs (stamped as made) and their links |
| `lib/ai-results.ts` | Translate with AI's saved results, timeout notes and pending names in a removed language |
| `lib/segments.ts` | Section URI moves, target collisions, new and re-aimed redirects |
| `lib/localize.ts` | String-to-object conversion for shared fields and asset text |
| `lib/releases.ts` | Which release versions a write may touch |
| `lib/locales.ts` | The `LOCALES` comment toggle that `npm run i18n:check` and the trim share |

The planners in `lib/` are pure and unit tested (`npm test`). Their tests derive the second language
from `LOCALE_IDS` and skip what needs one when a single locale is configured, and the section tests
skip when no section is left, so they pass in every locale mode and after any trim.

Full context: [Internationalization](../../docs/features/internationalization.md).

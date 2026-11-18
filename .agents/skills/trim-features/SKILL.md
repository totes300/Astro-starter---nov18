---
name: trim-features
description: Use when removing a shipped feature from this project (blog, authors, legal pages, contact form, the form layer, the announcement bar, Umami, the OpenAPI description, a media kind, a page-builder section, the Italian language, Translate with AI) in the code, the dataset, or both, when deleting content in a language the site no longer serves, when asking what of the starter a project still has or uses, and when teaching the trim to remove something it does not cover yet. Covers `npm run trim` and its `--status`/`--reconcile` modes, `npm run trim:update`, finishing the edits it cannot apply, purging stranded content with `--dataset-only`, the `project.json` record, adding an entry to `features.ts`, and fixing `manifest.test.ts` when it goes red. Do NOT use for building a new product feature (see `scaffolding-plop`), or for deleting individual documents an editor could delete in the Studio.
---

# Trimming features

`npm run trim` removes a feature across its files, registries, docs, dependencies and content. This
starter is a superset on purpose, so the normal moment for it is late: a project several months in
where someone concludes they never needed the blog.

The script does the deterministic part and refuses to guess at the rest. Your job is the rest.

## Core Rules

- **Ask the tree before you answer.** `npm run trim -- --status` says what this repository has of the
  starter: each feature's state, its content in every dataset, the project code importing it, and
  the edits it drifted from. Never answer "is the blog used?" from memory.
- **Two files, two owners.** `features.ts` is the starter's and is never edited in a project;
  `project.json` is the project's and is never edited by an update. A project fixes its record, never
  the manifest, and the starter fixes the manifest.
- **Run the script first, always.** `npm run trim -- --dry-run --feature <id>` before anything (a dry run
  needs `--feature`; there is no picker without a terminal). Never hand-edit
  something the script can do: if an edit belongs to a feature in `scripts/trim-features/features.ts`,
  rerun the script rather than reproducing it by hand.
- **Never hand-edit to make an anchor match.** If the script cannot find an anchor, finish that one
  edit by hand afterwards. Reshaping the code so the matcher fits is backwards and loses the record.
- **The dataset is never your judgement.** You do not decide what content is unused. `--dataset-only`
  diffs `sanity-schema.json` against the types the dataset stores; a `_type` with no schema entry is
  orphaned. For languages the config decides: content in a language `LOCALES` in `sanity/i18n.ts`
  does not configure is left behind. Those are the only rules. Do not delete documents on any other
  basis, and never treat an empty `language` as removable: it means missing, and
  `npm run sanity:migrate-backfill-language` sets it.
- **Do not weaken a matcher to make a run pass.** An anchor that matches twice is ambiguous, and the
  fix is to anchor it on more context, never to accept the first hit.
- **One feature at a time when a project has diverged.** Combined runs are fine on a clean tree, but a
  drifted project is far easier to review one feature at a time.

## Trigger Conditions

Apply this skill when the task is **remove / drop / delete / "we don't need"** for a feature this
starter ships: the blog, author profiles, legal pages, the form layer, the contact form, the
announcement bar, Umami analytics, the OpenAPI description, a media kind (Mux, video URL, Rive,
Lottie), a page-builder section, Italian (`language:it`, which is what "English only" means), or
Translate with AI (`ai-translation`, which a run switching off the last second language offers too).
Also apply it for "what of the starter are we still using?", after cloning or porting the trim into a
project, and when `npm test` fails in `scripts/trim-features/manifest.test.ts`.

## Execution Checklist

A person runs `npm run trim` and answers its questions; it covers every step below in order. An agent
has no terminal to answer prompts in, so it runs the same steps with flags:

1. `npm run trim -- --status`. If it says the project has no cut date, or lists anything as absent
   or unaccounted, run `npm run trim -- --reconcile` first and commit `project.json`.
2. Confirm the working tree is clean. The undo is `git checkout .`, and the script refuses a dirty
   tree for that reason. Do not reach for `--allow-dirty` to get past it. It also refuses a Node or
   npm outside `package.json`'s `engines`; run the `nvm use` it prints rather than editing `engines`.
3. `npm run trim -- --dry-run --feature <id>`. Read the plan: files to delete, edits per file, the
   dependencies and env vars going, anything already gone, and any project file that imports it.
4. Run it for real. If some edits do not resolve, or project code imports the feature, it prints them
   and asks; accept, and finish them yourself. With `--yes` it stops instead unless you pass
   `--partial`.
5. Work the unresolved list (see **Finishing an unresolved edit**), then the docs and skills the
   closing report says still describe the feature.
6. `npm run check` and `npm test`. On a partial run the type errors are the checklist: each one is a
   place the code still references what was removed.
7. In the starter, after editing `features.ts`: `npm run trim:verify`. It applies every trim to a
   throwaway worktree and runs the gates on the result, which is the only check that catches one
   feature reaching into another's files. It never writes to the working tree or a dataset.
8. `npm run trim -- --dataset-only --dry-run` to see what content is now stranded, per dataset (whole
   documents, section items left inside pages, and anything in a language `LOCALES` no longer
   serves), then drop `--dry-run` to delete it once the code is deployed: `--type <name>` for a type,
   `--language <id>` for a language, `--language` alone for text left in other languages. This needs
   `SANITY_API_EDIT_TOKEN` and a logged-in Sanity CLI, both checked before the export. A `--yes`
   purge of the dataset named in `.env` (the live site) stops before reading anything unless
   `--allow-live-target <that name>` repeats it; never pass that flag without the user naming the
   dataset. A refusal (a strong reference from what stays, a version in a scheduled release, a
   language `LOCALES` still configures, a plan that grew after the export) is content work for the
   user: report it, never work around it.
9. Read the closing report. It lists what was deliberately left: dangling weak references, orphaned
   section anchors, stale generated Markdown, prose that still describes the feature.

## Keeping a project's copy current

The trim in a project is a copy of the starter's. `npm run trim:update` replaces it (the folder, this
skill, the contributor doc) and never touches what `project.json` records; follow it with
`--reconcile` and `npm test`. When `--reconcile` cannot fetch the starter in a `git clone`, it will not
guess the cut under `--yes`: pass `--from <starter clone>` or `--cut-from`, never an early date. Do not port starter fixes by hand, and do not delete a manifest entry to make a project
test pass: record the feature as `adopted` instead. A feature the starter shipped after the cut reads
as never had, even once the project takes it; record it with `--reconcile --ported <id>` and the trim
offers it like a present one.

## Modelling a feature the trim does not cover yet

This starter ships more than the manifest describes, so growing it is ordinary work rather than a
rewrite. `docs/features/` is the inventory to work from: anything documented there and genuinely
optional is a candidate. An entry is data, not code, because `edits.ts` already knows how to perform
every removal in the README's edit-kind table.

1. **Find the boundary before writing anything.** Grep the whole repo for importers, not `src/`
   alone. A package the config or a script also imports is not this feature's to uninstall, and
   declaring it under `dependencies` uninstalls it for everyone.
2. **Separate what the feature owns from what it merely uses.** A component only this feature renders
   belongs in `paths`. A shared one stays, and goes under `orphans` when nothing else will use it
   once this is gone.
3. **Date it.** `since` is the day the entry is committed to the starter. A project cut before that
   never had the feature, so a file there by the same name is treated as the project's own. Nothing
   changes it at merge: a branch merged days later leaves it early, the safe side, since a project cut
   in between has none of the feature's files and is never offered it. Never a future date, which would
   hide the feature from projects that have it. Only an entry for code that already shipped takes an
   earlier date.
4. **Declare the Sanity surface.** `documentTypes` for stored documents, `sectionTypes` for page
   builder members, `fields` for a field the feature adds to a document it does not own (every
   `dropFieldByName` on a document schema needs one, so the purge can unset it). Never declare a
   namespaced type: a dot means a plugin owns it. A feature that stores nothing the purge can reach is
   `codeOnly`, the only way past the check that every feature can be purged.
5. **Write the edits**, preferring a structural kind over `replaceText`. A GROQ projection or
   `select` branch goes by `dropBlock`, and a line repeated once per sibling by `dropLines` with
   `every`, so the edit does not depend on which sibling a project removed first. A closing note that
   is moot when another feature goes in the same run takes `{ unless, text }`. Where text is unavoidable,
   match the smallest distinctive fragment, never begin or end the matcher on whitespace, and split a
   comment into its own `optional` edit so rewording prose cannot stop a trim. A group that only
   makes sense beside something else takes `requires`.
6. **`npm test`.** It checks every path, anchor, dependency, env var, doc and type the entry names.
7. **`npm run trim:verify <id>`.** It applies the trim to a throwaway copy and builds the result,
   which is the only check that catches another feature reaching into the files yours deletes.

### Modelling a starter language

A language the starter ships is one line in `features.ts`: `language({ id, title, dictionary, since })`.
Everything else follows from the rules the i18n code already keeps:

- `LOCALES` holds one entry per line, so `commentOutObjectInArray` can fold it into the commented
  line the locale toggle (`scripts/sanity-migrations/lib/locales.ts`) writes. The entry is never
  deleted: the commented line is the way back and the `npm run i18n:check` candidate.
- The language's UI strings live in `src/features/i18n/dictionaries/<id>.ts`, imported and registered
  in `UI_STRINGS` by a line each, so the trim deletes the file and drops both lines. Nothing else may
  name the language: no `Record<Locale, …>` literal with its key, no test hardcoding it.
- Its edits all `require` `sanity/i18n.ts`, so a project cut before i18n skips them, and its content is
  whatever the planner finds in that language: no `documentTypes`.
- Its `mentions` are only `English and <title>`, the sentence that says the starter is configured for
  it. Docs and tests use the language as their example second language, which stays true after the
  trim; `mentions.test.ts` fails when a language trim would list one of them.

Never generate an entry from `LOCALES`: a language a project added is the project's, turned off by
commenting out its line, deleting its dictionary, and `npm run trim -- --dataset-only --language <id>`.

When a change reshapes an anchor that projects cut earlier still have, keep both: the new text in a
group that `requires` the path marking the new shape, the old text in a twin with `requiresAbsent`,
and the old file captured under `scripts/trim-features/fixtures/pre-i18n/` (or a sibling fixtures
folder for the next reshape) so `manifest.test.ts` proves it.

### Couplings run one way more often than both

`forms` implies `contact-form`, because the contact form is built out of the layer and cannot outlive
it, while a project can drop the contact form and keep the layer to build its own. `ai-translation` is
offered rather than implied when a run switches off the last second language (`needsSecondLanguage`): it only works beside a
second language, but a project may keep it for one it plans to add. `blog` and
`authors` imply each other, because an article's byline is part of the route.

This is not a judgement to make in advance. Declare the entry, run `trim:verify`, and read the build
errors: they name the direction.

## Scope Guidance

### Finishing an unresolved edit

An unresolved edit means this project rewrote that code. The script's description states the intent;
apply it to whatever is there now. The three that come up:

- **A GROQ projection** (`src/features/agents/query.ts`, `src/sanity/queries.ts`,
  `src/pages/api/agents/llms-txt.ts`). The projection has been customized, so the exact span no longer
  exists. Remove the fields belonging to the departing type and nothing else. A byline built from
  several fields is still a byline: remove the whole thing rather than part of it.
- **A conditional in a component template** (`src/pages/[...uri].astro`). A ternary branching on the
  removed `_type` collapses to its other branch. Keep whatever wrapper markup the project added around
  it. The AST edits only ever touch frontmatter, so anything in the template half arrives here.
- **A type list** (`_type in [...]`, the `tags` passed to `cacheResponse()`, `to:` reference targets). Remove the
  entry, leave the rest, and check whether the surrounding construct still needs to be a list at all.

After each one, rerun `npm run check.types`. It is the fastest confirmation you removed the right
thing, because anything you missed still references a deleted symbol.

### When the manifest test is red

In the starter, `manifest.test.ts` asserts everything, and fails for two opposite reasons that need
opposite fixes. An anchor no longer resolves, usually because a registry moved: update the manifest,
not the test. Or something in the tree is not declared: a section with no entry (flat file or
folder), or a document type that is neither removable nor in `CORE_DOCUMENT_TYPES`. That is starter
kit that lost its entry, and it gets the entry back.

In a project, the per-feature assertions are skipped (`--status` shows the same drift), and only the
coverage checks and the record run. An unaccounted section or type there is the project's own:
`npm run trim -- --reconcile` records it, and plop does it for scaffolded ones. A record entry the
tree contradicts (a trimmed feature whose files came back) means fixing `project.json`. What you must
never do, in either, is delete the assertion or edit `features.ts` in a project.

Prefer a structural edit kind over `replaceText`: they name one specific binding, key or element, so
they survive reformatting and are treated as already satisfied when the thing is simply absent. Where
text is unavoidable, match the smallest distinctive fragment rather than a block, and never begin or
end that fragment on whitespace: matching collapses whitespace, so a leading newline or indent
swallows the blank line beside it and collides with the edit that owns the line above. A matcher that
only removes a comment belongs in a separate `optional` edit, so rewording the prose cannot stop the
trim.

### When the manifest does not fit at all

In a project that has restructured, the run refuses to start: the shared registries the manifest is
written around are not where it looks, so it is describing a different repository and every file it
cannot find would otherwise be reported as "already gone". That is the correct outcome rather than
something to force. Use the `--dry-run` plan as a specification: each line states one intent, in
order. Apply them by hand, then run the gates.

A softer version of the same problem gets a warning rather than a refusal. A feature that is only
partly present is either half-removed by an earlier run, or kept by this project under a new meaning:
the route is gone but a document type survived because it is used for something else now. The second
case is `adopted`: record it with `--reconcile` (or `--adopt <id>`) and the trim stops offering it.
Otherwise the run prints which of its files are left and which are absent, and the ones left are the
ones about to be deleted. Read that list before confirming, especially with `--dataset`.

`--dataset-only` still works unchanged there, because it reads the schema rather than the manifest.

### Handoffs

- Building a new product feature rather than removing one: **`scaffolding-plop`**. Teaching the trim
  to remove something is the section above, not a handoff.
- The removal changes what agents are served: **`agent-markdown`**.
- Page-builder shape questions while removing a section: **`section-anatomy`**.
- Turning a language back on, launching a new one, or what switching one off leaves in the code: **`i18n`**.
- Documentation left inaccurate by the removal: **`docs-maintenance`**.

## Non-Goals

- **Deleting individual documents.** An editor does that in the Studio. This removes a whole type.
- **Disabling rather than removing.** `sanity/utils.ts` exports `selectByName`, which the schema
  factories accept for whitelisting and blacklisting. That is the tool for switching something off;
  this script removes.
- **Rewiring what a removal breaks.** A footer link to a deleted legal page becomes a dangling weak
  reference. The purge plan names every holder; repairing them is content work, not this.
- **Trimming to make a build smaller.** Removing an unused feature costs nothing at runtime; do it
  because the content model should not offer it, not for bundle size.
- **Changing the default locale.** That rewrites every URI rather than removing anything, so the trim
  refuses it.
- **Writing redirects.** A language removal suggests 301s and never writes them.

## Done Criteria

- `npm run check` and `npm test` pass.
- `npm run build` passes when a route was removed.
- No unresolved edit is left unaddressed, or each one is explicitly reported as intentionally kept.
- `npm run trim -- --dataset-only --dry-run` reports nothing stranded, or the remainder is named and
  explained.
- The closing report's leftovers have been actioned or handed back to the user.

## Reference Files

- `scripts/trim-features/README.md`: the flow, every flag, the edit kinds, and how to add a feature.
- `docs/features/trimming-features.md`: the contributor-facing version, including why skipping the
  dataset half leaves URLs in `sitemap.xml` that no longer resolve.
- `scripts/trim-features/features.ts`: the starter's manifest. One entry per removable feature, no logic.
- `scripts/trim-features/project.json`: the project's record; `project.ts` reads it and derives each state.
- `scripts/trim-features/schema.ts`: the schema-versus-dataset diff behind `--dataset-only`.
- `scripts/trim-features/language-removal.ts`: the one plan behind every purge, shared with
  `npm run sanity:migrate-remove-language`; `language.ts` reads what `sanity/i18n.ts` configures.
- `scripts/trim-features/verify.ts`: `npm run trim:verify`, which builds each trim in a throwaway copy.

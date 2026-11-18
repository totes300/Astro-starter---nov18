# Trim features

`npm run trim` removes a feature from this starter: its files, its registry entries, its docs, its
dependencies, and, when you ask for it, its content in Sanity.

The starter is a superset on purpose, so every project that starts from it inherits a blog, legal
pages, a contact form, a form layer, an announcement bar, Umami analytics, an OpenAPI description,
four media kinds beyond images and files, five page-builder sections, a second language (Italian)
and Translate with AI, whether or not the client wants them. Removing
one by hand means thirty-odd files across routes, schemas, registries, GROQ strings, sitemap tags and
docs, and it never includes the dataset. This does all of it deterministically, or refuses to start.

It **only removes**. Nothing is added back and nothing is rewired: a feature whose removal would mean
rewriting a route rather than unwiring a registry pulls in the feature it is welded to instead. The
one exception is a language: its `LOCALES` entry in `sanity/i18n.ts` is commented out rather than
deleted, because the commented line is the way back and the candidate `npm run i18n:check` switches on.

Undo is `git checkout .`, which is why a dirty working tree stops the run.

## Usage

`npm run trim` on its own is the guided run: it checks for a newer trim, shows the overview, offers
to record what is unrecorded, asks whether to remove features or delete content an earlier trim left
behind, and after a removal offers the content (later by default). The flags are for scripts.

```bash
npm run trim -- --status                           # what this repo has of the starter, and uses
npm run trim -- --reconcile                        # record what the tree cannot say (once per project)
npm run trim:update                                # take the starter's current trim, keep project.json

npm run trim                                       # interactive
npm run trim -- --dry-run --feature blog           # print the plan, write nothing
npm run trim -- --feature blog                     # skip the picker
npm run trim -- --feature blog --dataset           # also purge the dataset
npm run trim -- --feature blog --dataset trim-test --yes

npm run trim -- --dataset-only --dry-run           # what content is stranded?
npm run trim -- --dataset-only                     # purge it, nothing else
npm run trim -- --dataset-only --language it       # delete a language LOCALES no longer serves
```

| Flag | Meaning |
| --- | --- |
| `--feature <id...>` | Feature ids to remove; skips the picker. Required with `--yes` or `--dry-run` |
| `--dataset [name]` | Also purge the dataset. Optionally names the dataset to read and purge |
| `--dataset-only` | Purge only, against a tree an earlier run already trimmed. Implies `--dataset` |
| `--type <name...>` | With `--dataset-only`, the stranded types or `type.field` fields to delete |
| `--language [id...]` | With `--dataset-only`, the languages LOCALES no longer serves to delete; with no id, only clean text left in other languages |
| `--no-dataset-check` | Skip the usage report and choose without it |
| `--no-knip` | Skip the sweep for what the manifest did not know about |
| `--allow-dirty` | Run against an uncommitted tree (undo stops being `git checkout .`) |
| `--allow-live-target <name>` | Let a `--yes` run purge the `.env` dataset; the name must repeat it |
| `--partial` | Apply the edits that still resolve; report the rest as manual follow-up |
| `--status` | Print every starter feature's state, content per dataset, importers and drift. Writes nothing |
| `--reconcile` | Record the cut date, adopted and ported features and the project's own sections and types in `project.json` |
| `--cut-from <date>` | With `--reconcile`, the cut date (`YYYY-MM-DD`); required to reconcile the starter's own clone non-interactively |
| `--adopt <id...>` | With `--reconcile`, starter features this project took over |
| `--ported <id...>` | With `--reconcile`, starter features this project took after its cut, so the trim offers them |
| `--dry-run` | Print the plan and exit |
| `-y`, `--yes` | Answer every prompt |

## The flow

1. **Preflight.** A dirty tree aborts, because `git checkout .` beats any backup scheme. So does a
   shell whose Node or npm falls outside `package.json`'s `engines`: with `engine-strict` the install
   would fail after the files are gone, so the run stops first and prints the `nvm use` to fix it. Then the
   landmarks: the shared registries this manifest is written around, which no feature owns and no
   trim removes. One of them missing means the manifest is describing a different repository, so the
   run stops rather than reporting every file it cannot find as "already gone".
2. **Survey**, printed *before* the question: every starter feature's state, its content in every
   dataset (production first), the project code that imports it, and the edits it has drifted from.
   Content counts drafts and documents waiting in a content release, not only what is published.
3. **Pick** from the features still here, ported ones included. Coupled ones auto-select with a printed
   note; a coupled one that is already gone is skipped. Asking for one that is trimmed, removed,
   adopted or never here fails with the reason. A feature only *partly* here is spelled out: which files are left and which
   are absent, because the files still standing are the ones about to be deleted.
4. **Plan**: files to delete, edits by file, dependencies, env vars, docs, and the purge plan. Edits
   the project changed away, and project code importing the selection, are listed as work for a
   human, and need `--partial` under `--yes`.
5. **`📋 Summary` and one confirmation**, defaulting to no. `--dry-run` stops here.
6. **Apply** → record the features as trimmed in `project.json` → `npm install` (only if a dependency
   went) → `npm run sanity:typegen` → `npm run format`. A failure from here on says exactly how far
   the run got: what was deleted and edited, and whether the record was written.
7. **Purge**, behind `--dataset`, its own confirmation and an automatic export to `./backups/`.
   Everything that would stop it is checked before the export: a strong reference from a document
   that stays, a version in a scheduled release, `SANITY_API_EDIT_TOKEN`, and the `sanity login` the
   export needs. After the export the plan is made again from fresh reads, and the purge stops,
   writing nothing, if it grew. A language's content goes only once `LOCALES` no longer configures
   it: when its comment-out is left to you, the language stays on and so does its content.
8. **knip sweep** for what the manifest did not know about (unused files, packages, and the exports
   and types the trim stopped calling), the docs, skills and tests that still name the feature, the
   quality gates, and a report of what was deliberately left for a human. Each closing note is printed
   only when it applies to this run: the sitemap note only when a removed routed type still has
   documents, the thumbnail note only for a section that declares none.

## What the trim knows about this repository

The manifest belongs to the starter; what a project did with it belongs to the project. So there are
two files, and the trim never guesses what one could record:

| File | Owner | Holds |
| --- | --- | --- |
| `features.ts` | The starter. Replaced by `npm run trim:update`, never edited in a project | What each feature is made of, and `since`: the day it was committed to the starter (a later merge leaves it early, the safe side) |
| `project.json` | The project. Never touched by an update | `starter.cutFrom`, a state per feature it decided about, its own `sections` and `documentTypes` |

A feature's state is the record's when there is one, and the tree's otherwise:

- **trimmed / removed / adopted / ported** come from the record. `adopted` is a feature the project took over
  and changed (the blog that became a research section): never offered, never asserted. `ported` is a
  feature that joined the starter after the cut and that the project took anyway (`--ported <id>`,
  `{ "state": "ported", "on": "<date>" }`): it counts as present, so it is offered and its drift is
  shown, and a ported feature with none of its files left is a conflict until its entry goes.
- **never had**: `since` is later than `cutFrom`. A file by its names is the project's own, which is
  how a project's `HeadlineSection` written before the starter shipped one is never offered as kit.
- **present / partial / absent** otherwise, by which of its files exist.

**Role.** The starter is the repository `project.json` names, cloned from its own origin, with no cut
date. Anything else is a project. The role decides how strict `manifest.test.ts` is: in the starter
every path and anchor must resolve; in a project those checks are skipped (a project changes what it
keeps, and `--status` shows that drift without failing `npm test`), while the coverage checks still run
against the record.

**Keeping the record without thinking about it.** `npm run sanity:project-setup` stamps `cutFrom` in
a new project. Plop runs `own.ts` after scaffolding a section or a prefix-route type, which records it
as the project's. `--reconcile` covers everything else once: it defaults the cut to the first
commit's date, records whatever is absent as removed, asks about anything partial or drifted, and
records what the manifest does not know as the project's own.

The cut it suggests is the fork point with the starter (`git merge-base` after fetching it), which is
exact for a `git clone`. A template copy shares no history, so there it is the first commit.
`starter.root` in `project.json` names the starter's own first commit, which is how a clone is told
apart from a template copy: when a clone cannot reach the starter, the suggestion falls back to the
last change to the manifest, which is late rather than early. Too early would hide real starter
features as "never had"; too late only misses a name clash. `--yes` refuses to record that fallback
and asks for `--from` or `--cut-from`.

**Updating.** `npm run trim:update [-- --from <url or path>] [--ref <ref>]` fetches the starter,
replaces this folder, the skill and `docs/features/trimming-features.md`, deletes files the starter
dropped, adds missing `trim*` scripts to `package.json`, and leaves what `project.json` records
alone (it only fills in the starter's `repository` and `root` when they are missing). A feature the
starter added after the cut arrives as "never had". It refuses a starter ref that predates
`project.json`, since taking it would delete the code that reads the record.

The updater that runs is the project's current copy, so a change to the updater itself takes effect
on the next run: run it twice after a large jump. A project that has no `update.ts` yet runs the one
from a starter clone: `node --import=tsx <starter>/scripts/trim-features/update.ts --from <starter>`.

`npm run trim:verify` works in a project too, and only verifies what is still offered there.

## Purging later

The code removal and the content removal are two decisions, usually days apart: the edit token, or
the `sanity login` the pre-purge export needs, is often not in place when the code goes.
`--dataset-only` is the second half on its own.

```bash
npm run trim -- --dataset-only --dry-run          # read-only: what is stranded?
npm run trim -- --dataset-only                    # pick from it and delete
npm run trim -- --dataset-only --type person --dataset trim-test --yes
npm run trim -- --dataset-only --type person --allow-live-target production --yes
npm run trim -- --dataset-only --language it --dataset trim-test --yes
npm run trim -- --dataset-only --language --dataset trim-test --yes   # text left in other languages only
```

**The live dataset needs its name repeated.** A `--yes` run (here or with `--dataset`) that would
purge the dataset named in `.env` stops before reading or changing anything unless
`--allow-live-target <that name>` repeats it, and the error prints the project and dataset. An
interactive run asks instead, and its confirmation names the project as well as the dataset.

**It reads no manifest.** "Is this content stranded?" has an exact answer that needs no knowledge of
where any file lives: a `_type` with documents but no entry in `sanity-schema.json` cannot be
rendered, queried by the app, or opened in the Studio. So this half diffs the extracted schema
against the types the dataset actually stores.

That makes it the one genuinely portable piece here. It works in a project that renamed its types or
moved its schema folder, where the manifest cannot resolve a single anchor, and it finds orphans of
types nobody ever wrote a manifest entry for. Any type with a dot in its name is excluded, because a
plugin owns it: Mux writes `mux.apiKey` at runtime, the extract never mentions it, and it holds live
credentials. It reads one dataset per run, so run it once per dataset.

Fields are the one exception. Nothing lists the keys a document stores, so a field a feature put on
a document that stays (`siteSettings.contactFormNotificationEmails`, `site.announcement`) needs a
name to look for: the manifest's `fields` nominate them, and one is only offered once the extracted
schema has stopped declaring it on its type. They are unset, never deleted, and named on the command
line as `--type site.announcement`.

It also finds page-builder items whose `_type` the schema no longer declares: a section trimmed from
the code leaves its items inside pages, and the extract names every member type (as an inline `_type`
literal), so the diff is exact there too. Those are stripped from their pages, not deleted.

**Every read sees drafts and release versions.** Reads run through `sanity exec` on your
`sanity login`, under the raw perspective: `sanity documents query` cannot set one, and from API
version 2025-02-19 the default is `published`, which would hide both. Each count keeps three buckets
by `_id`: published, `drafts.<id>` and `versions.<release>.<id>`. A document listed as holding a
reference or an anchor is named once, under its published id, however many of its copies match.

**Languages: the config decides.** A language is stranded when the dataset holds anything in it
and `LOCALES` in `sanity/i18n.ts` does not configure it, active or commented alike: documents of
the translated types (`I18N_DOCUMENT_TYPES`, so a type with its own `language` field is never read),
translation links, the language's text on the shared fields `LOCALIZED_FIELDS` names, and asset text.
Text counts even after every document in the language is gone, so a cleanup-only run
(`--language` with no id) finishes what a hand deletion or an interrupted purge left. With one
locale left, asset text stored per language is flattened back to the plain string the media library
then edits. The default locale, a configured one and an empty `language` are never removable: an
empty one means missing, and `npm run sanity:migrate-backfill-language` sets it. This is what
`npm run trim` deletes for any language the site no longer serves, Italian or one a project added.

It touches no files, so it does not care whether the working tree is clean, and it skips
`npm install`, typegen, format, knip and the gates. `--dry-run` needs no `--type`; `--yes` needs
`--type` or `--language`, because it deletes without asking and should name what it is deleting.

## One plan for every purge

Every purge, a type's or a language's, runs on one plan from `language-removal.ts`, which
`npm run sanity:migrate-remove-language` shares. It reads every copy (published, `drafts.<id>`,
`versions.<release>.<id>`) and plans:

- the deletes, in **one transaction**, so a strong reference between two doomed documents is not a
  problem and no order is needed;
- **translation links** (`translation.metadata`) as a companion: a link goes with its target, a
  group left with fewer than two links is deleted, and the rest are repaired, in that same
  transaction, so a link can never block a blog purge or dangle after one;
- what points in from *outside* the set, read whole and uncapped: a strong reference would make
  Sanity refuse the transaction, so the run refuses before exporting anything, and a weak one is
  listed as dangling;
- release versions: one in a release that is not active is refused (unschedule it first), and so is
  a section strip or a field unset that would write to one; the rest are discarded through the
  Actions API before the transaction, since nothing can reference a version;
- for a language, its text on documents that stay and on assets, cleaned in batches a rerun
  finishes, and 301 suggestions from each removed URL to its default-language sibling. Only the
  removed languages' text goes; text left in other unserved languages goes when the run is asked to
  clean it (`--language` alone, or that option in the picker).

## Layout

| File | Owns |
| --- | --- |
| `trim.ts` | The flow: flags, preflight, plan, confirmation, apply, purge, report |
| `features.ts` | The starter's manifest. One declarative entry per removable feature, no logic |
| `project.json`, `project.ts` | The project's record, its role, and each feature's state |
| `status.ts` | The survey behind `--status`, the picker and `--reconcile` |
| `importers.ts` | Which files import a path, aliases resolved: the code-side answer to "is it used?" |
| `mentions.ts` | The docs, skills and tests that still describe a removed feature |
| `notes.ts` | The closing report's notes, each printed only when its condition holds |
| `engines.ts` | The preflight check of Node and npm against `package.json`'s `engines` |
| `own.ts` | Plop's hook: records a scaffolded section or type as the project's |
| `update.ts` | `npm run trim:update` |
| `edits.ts` | The pure source transforms, over the TypeScript AST |
| `dataset.ts` | The GROQ usage report, the purge plan and the purge |
| `language-removal.ts` | The one plan behind every purge: copies, translation links, references, releases, text per language. Imports nothing |
| `language.ts` | Reads `LOCALES` by AST and the translated types from `sanity/constants.ts`; nothing in a project from before i18n |
| `locale-toggle.ts` | Loads the `LOCALES` toggle for the tests that prove the comment-out agrees with it |
| `fixtures/pre-i18n/` | Files as they were before i18n, for every file whose anchors i18n moved |
| `raw-query.ts` | The one read `dataset.ts` runs through `sanity exec`, under the raw perspective |
| `knip.ts` | The second pass, diffed against a baseline taken before the trim |
| `verify.ts` | `npm run trim:verify`: every trim applied to a throwaway copy, and the gates run on it |
| `manifest.test.ts` | The manifest checked against the repository it describes |

## Verifying

`npm run trim:verify` applies every trim to a throwaway `git worktree` built from the tree as it
stands, runs typegen, the typecheck and the tests against each result, and tears the copy down. Pass
feature ids to narrow it. Typegen runs because `npm run trim` runs it: a media kind's trim narrows
the hand-written `MediaFragmentResult`, and only regenerated query types agree with it. It reads the
project id from `.env`, which is linked into the copy, never copied, and runs with `DO_NOT_TRACK=1`,
so the Sanity CLI never calls the Sanity API. The working tree is never written to and no dataset
is read or written, so it is safe against a project that is live.

It is the gate `manifest.test.ts` cannot be. That one checks every anchor still resolves; this checks
that what is left over still compiles, which is a different question and the one that catches a
feature reaching into another's files. Run it after editing a feature entry, and before merging.

It also greps what survives for the paths the trim deleted, because the typechecker is blind to a
stale `import()` inside a `.d.ts` while the base tsconfig sets `skipLibCheck`, and a custom element
registry is exactly the kind of file that lists modules by path.

For a language it proves the single-locale result compiles and passes the tests, with
`sanity-schema.json` and `sanity/types.ts` regenerated in that mode. `npm run i18n:check` is the
deeper check: it also proves no query drops out of typegen when the mode switches.

## Adding a feature

This starter ships more than the manifest describes: `docs/features/` lists the inventory, and only
some of it has an entry here. Growing that coverage is ordinary work, and the **trim-features** skill
carries the procedure, including how to find a feature's boundary without uninstalling a package
something else needs.

Add an entry to `features.ts`. It is data, not code:

```ts
{
  id: "newsletter",
  title: "Newsletter",
  summary: "The signup section and the subscriber inbox.",
  since: "2026-10-01", // the day it is committed to the starter: projects cut earlier never had it
  implies: ["section:newsletter"],
  paths: ["sanity/schemas/documents/subscriber.tsx"],
  edits: [
    { file: "sanity/schemas/index.ts", edits: [
      { kind: "dropImport", id: "subscriber" },
      { kind: "dropArrayElement", arrayName: "schemaTypes", id: "subscriber" },
    ]},
  ],
  dependencies: ["some-esp-sdk"],
  env: ["NEWSLETTER_API_KEY"],
  documentTypes: ["subscriber"],
  fields: [{ documentType: "siteSettings", name: "newsletterListId" }],
  docs: ["docs/features/newsletter.md"],
  notes: [{ unless: "forms", text: "The form layer stays: trim `forms` too if nothing else needs it." }],
}
```

`fields` names a field the feature adds to a document it does not own; every `dropFieldByName` on a
document schema must have one, which the manifest test enforces, so the purge can unset what is
stored under it. A field a wrapper adds to every type it wraps (Translate with AI's `aiTranslation`
record, from `withAiTranslationRecord`) names that module in `addedBy` instead: the feature deletes
the module, and the manifest test checks it lists every type the extracted schema gives the field.

`needsSecondLanguage` marks a feature that only works beside a second language. It is not `implies`:
a run that switches a language off and leaves one locale (`offeredWithOneLocale`) asks about it, default yes, and a `--yes` or
`--dry-run` run prints the `--feature` to add instead, because a project may keep it for a language it
plans to add. `ai-translation` is the one today.

A language the starter ships comes from the `language()` factory: one line, `language({ id, title,
dictionary, since })`. It owns the dictionary at `src/features/i18n/dictionaries/<id>.ts`, comments
out its `LOCALES` entry, drops the dictionary's import and `UI_STRINGS` key, and sets `language`,
which is what the purge deletes. Its edits all `require` `sanity/i18n.ts`. It is never generated
from `LOCALES`: a language a project added is its own, so turning it off is one comment plus
`npm run trim -- --dataset-only --language <id>`. A note in the object form is dropped when the feature `unless` names goes in the
same run, so the report never says something stays that the run just deleted.

Then run `npm test`. It also checks the other direction, which is the one a growing repository
breaks. Adding a page-builder section or a document type leaves every existing anchor resolving
perfectly while the new thing has no way to be removed, so a section nobody accounts for fails, and a
registered document type must be removable, in `CORE_DOCUMENT_TYPES`, or recorded as the project's.
The section half counts both shapes, flat file and folder: a section earns a folder only once it grows
a companion, and `plop` scaffolds the flat one.

In the starter, an unaccounted section is kit that lost its entry, which is the bug this check exists
for. In a project it is the project's own, and plop or `--reconcile` records it in `project.json`
once. It also asserts statically that nothing outside a feature imports what the feature deletes,
which is the cheap half of `trim:verify`.

`manifest.test.ts` checks every path, anchor, dependency, env var, doc and
schema type against the real tree, so a typo fails immediately rather than surfacing months later as
a half-trimmed repo.

Declare what the feature owns, not what only becomes unused in combination with another one. An
import that two features share goes unused only when both are removed, and no single entry can say
that; `npm run format` strips it, and the knip sweep names anything larger.

A shared layer only this feature happened to use goes under `orphans`. Those are reported, never
deleted, because whether they go is a judgement about what you plan to build. They are declared
rather than left to the knip sweep, which only names a file nothing at all imports: a module kept
alive by its own colocated test is invisible to it, and the sweep found 7 of the contact form's 25.
An orphan is reported only once nothing outside it imports it (a test or a `.d.ts` does not count),
so one shared by several features, like the section preview samples, appears when the last goes.

### The edit kinds

`edits.ts` walks the TypeScript AST rather than running regexes, because the registries it edits are
enumerations with `// PLOP: Add …` markers and this is the inverse of `plopfile.mjs`.

In a component, the AST kinds only ever see the frontmatter between the `---` fences, so a class name
in the markup that happens to match a removed key is never touched. `replaceText` and `dropLines` are
literal matchers and run over the whole file, which is where the conditional a removal has to
collapse actually lives.

| Kind | Removes |
| --- | --- |
| `dropImport` | One specifier, or the whole `import` when nothing it binds survives the batch |
| `dropExport` | One name from an `export { … }` clause, or the statement when nothing in it survives the batch |
| `dropArrayElement` | An identifier from a named array (`article` from `schemaTypes`), or a call to it (`muxInput({ … })` from `plugins`) |
| `dropObjectProperty` | A key from a named object, including `[SINGLETON_IDS.blog]:` |
| `dropVariableStatement` | A `const`, `function`, `type` or `interface`, with its JSDoc |
| `dropCallInArray` | A builder chain matched by its `.title()` argument |
| `dropStringFromArray` | A string entry from a named array, or from every array passed to a named call (`visibleIfType([…])`) |
| `dropObjectFromArray` | `{ type: "article" }` from a reference target list |
| `commentOutObjectInArray` | Comments out `{ id: "it" }` in `LOCALES` as one line, `id` first, the one edit that keeps what it takes |
| `dropFieldByName` | A `defineField({ name })` from a `fields` array, including one spread in behind an option |
| `dropUnionMember` | One string literal from a union, by type alias or property name |
| `dropSwitchCase` | A `case "<value>":` clause and its body |
| `dropCallStatement` | A `test("…", …)` block, or an `it("…", …)` inside a `describe`, whose title names what is removed |
| `dropJsonKey` | One key from a generated JSON file, re-serialised so no comma dangles |
| `dropBlock` | A brace-balanced block by the text that opens it, for a GROQ projection or `select` branch |
| `dropLines` | Whole lines, for Markdown and `.env`; `every` takes however many there are |
| `replaceText` | A literal span, for GROQ strings, which have no AST here |

Every matcher must hit **exactly once** (or its declared `count`). A zero match means the anchor
moved; an extra match means it is ambiguous. `commentOutObjectInArray` writes the line the locale
toggle (`scripts/sanity-migrations/lib/locales.ts`) writes and re-enables, and a test holds the two
together. A trailing comment moves onto its own line above; an entry sharing its line, or holding a
comment or a template literal, is left for a human with the reason. It counts as done only when the
array is one literal list of `{ id: "…" }` entries without the id active, so a computed `LOCALES` is
reported, never silently passed. `dropLines` with `every` is the exception, for a line
repeated once per sibling, like the `"rive": null,` each media branch carries: another removal thins
those out first, so a fixed count would tie one feature to the order the others went in. For the
same reason a GROQ branch goes by `dropBlock` rather than by matching its whole text.

A text matcher marked `optional` is the exception: finding nothing leaves the text alone and says
nothing. It is for spans whose removal is cosmetic, which in practice means the comment above a
branch being removed elsewhere. Prose is reworded far more often than the code under it, and the
anchors that broke first here were comments, not code. Split the comment off as an optional
`dropLines` and leave the code matcher required, so a reworded sentence cannot stop a trim.

### When a project has moved on

The usual case is not a fresh clone. Someone decides they never needed the blog after months of
building, by which point they have added fields to queries and edited the routes around them, and a
few anchors will have moved. "Nothing was changed" is a useless answer there.

So the whole plan is resolved first, and then:

- **Every anchor resolves**: it runs, as before.
- **Some do not, interactively**: the ones that failed are printed with their file, and you are
  asked whether to apply the rest and finish those by hand. Default is no.
- **Some do not, with `--yes`**: it stops, unless you pass `--partial`. A scripted run should not
  quietly do most of a job.

A partial run repeats the leftovers in its closing report, and `npm run check` will fail on them,
so the type errors are the checklist. The undo is still `git checkout .`.

A path that is already gone is never a failure: the goal is a tree without the feature, and a file
someone deleted by hand is a step towards it.

### Keep matchers narrow

`dropLines` and `replaceText` match literal text, and a wide matcher breaks the moment anything near
it is edited. Prefer a structural kind, and where text is unavoidable, match the smallest distinctive
fragment rather than a block: a one-line matcher survives reformatting, re-indentation and having a
wrapper added around it, where a fourteen-line one does not. `dropFieldByName` exists for exactly
this reason: a Sanity field's `name` cannot change without changing the content model, while
everything else in its definition is what a project customizes.

`dropLines` is the one transform with no structural safety net, since it deletes whatever text it
matches rather than a node. The plan prints the lines themselves underneath the matcher so they can
be read before they go.

A group of edits that only makes sense beside something takes `requires: "<path>"`. When that path is
absent the whole group is skipped rather than reported, which is how a project on an older cut of the
starter stops being told to hand-finish edits for a feature it never had. Anything that reaches the
literal matchers would otherwise read "never here" as "here in a shape I cannot recognise".
It is judged per group, before the groups of a combined run are merged into one list per file, so
one feature's `requires` never decides whether another feature's edits to the same file run.

When a change reshapes an anchor, a project cut before it still has the old shape. The new text goes
in a group that `requires` the path marking the new shape, and the old text in a twin group with
`requiresAbsent` naming the same path, so exactly one runs. i18n is the case today: both twins name
`sanity/i18n.ts`, and every file whose anchors i18n moved is captured under `fixtures/pre-i18n/`
from the last commit without it, so `manifest.test.ts` proves the old shapes still trim. A group
with `requires` or `requiresAbsent` is never a landmark, since a project may not have it.

The trim statically imports only its own folder, `../lib/cli`, `../lib/sanity-client`,
`../sanity-dataset/lib` and `../sanity-dataset/dataset-picker`: `trim:update` restores only this
folder, so anything else a project cut earlier may not have. `manifest.test.ts` enforces it.

Never begin or end a `replaceText` matcher on whitespace. Whitespace is collapsed when matching, so a
leading newline or indent becomes `\s+` and swallows the blank line beside it, which then collides
with whatever edit owns the line above. Start and end on a real token and let the formatter tidy what
is left.

### Selections that resolve but do not work

Anchor checking cannot catch a selection whose *parts* are each valid and whose *combination* is not.
Removing every page-builder section left on disk, the project's own included, is the one that ships:
each edit resolves perfectly, but the result is an empty `sections` registry, which types `SectionName` as `never` and takes the Studio and
the build with it. `findSelectionConflicts` in `features.ts` runs alongside the anchor check, before
anything is written, and refuses it. Add to it if a future feature has the same shape.

## Why knip is stage two, not the driver

Knip cannot decide this. Nothing here is statically unreachable: `features/blog/**` is imported by a
route entry point, `article.tsx` is an entry in `sanity/schemas/index.ts`. It is also blind to the
three things that matter most: Sanity schema registries, where an array entry *is* the use; GROQ
strings that name `_type`s as plain text; and the dataset. And "this client has no blog" is a product
decision, not a static fact.

Where it earns its place is *after* the manifest has unwired a feature: the shared helper only that
feature used, the dependency that just became unused. The sweep diffs against a baseline taken before
the trim, so it reports what this run orphaned rather than the dozen files knip always finds here.

It is deliberately **not** in `npm run check`. The starter is a superset on purpose (`createIconField`
has no call sites by design), so a standing knip gate would fight that on every run.

One caveat worth knowing: knip collects imports from `.astro` files by regex rather than by parsing
them, so an unused *export inside* a component goes unreported. File-level and dependency-level
results still hold, which is what this sweep reads.

## What it does not do

- **Rewire.** A `legalPage` link in the Site singleton's footer becomes a dangling weak reference; it
  is reported, not repaired.
- **Take the content with it.** Routes are file-based, so deleting one is enough for a real `404`.
  The documents behind it stay, and the sitemap selects every document with a `uri.current` and no
  filter on type, so `/sitemap.xml` keeps advertising URLs that now 404. That is what `--dataset` and
  `--dataset-only` are for.
- **Regenerate stored Markdown.** `agentMarkdown.content` and `siteSettings.llms.content` are stored
  verbatim and go stale after a purge; regenerate them from the Agents tab.
- **Reach nested media.** A media item is an object inside a page, a section or rich text. After a
  media kind is trimmed, an item still set to it renders nothing, and the Studio flags its leftover
  fields until an editor picks another kind.
- **Find every section anchor.** `internal.sectionTarget` is a plain string, not a reference. The
  report covers a section's own `appLink`; one written into a rich text annotation is not reachable by
  GROQ, so the anchor report is a floor, not a guarantee.
- **Write redirects.** Switching a language off suggests a 301 from each removed URL to its
  default-language sibling, read from the translation links, and lists Settings redirects that now
  land on a 404. Nothing is written: publish them in Settings > Redirects, then redeploy.
- **Delete assets.** Asset text in a removed language is unset or flattened; the assets stay.
- **Change the default locale.** That is a URI rewrite, not a removal, so it is refused.

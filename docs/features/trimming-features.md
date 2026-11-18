# Trimming features

This starter is a **superset**. Every project that starts from it inherits a blog, legal pages, a
contact form, a shared form layer, an announcement bar, Umami analytics, an OpenAPI description, four
media kinds, five page-builder sections, a second language, Italian, and Translate with AI, whether or
not that project wants them. That is deliberate: it is cheaper to remove a feature you can see than to rebuild one you
deleted early.

`npm run trim` is how you remove one, on day one or months in. It is the only command you need:

```bash
npm run trim
```

It walks you through the whole job, one question at a time:

1. **Is this copy of the trim current?** If the starter ships a newer one, it offers to update first.
2. **What does this project have?** Every starter feature, its content in each dataset, and any of
   your code that imports it.
3. **Is anything unrecorded?** The cut date, a starter feature you rebuilt as your own, sections you
   wrote by hand. It offers to record them before it offers anything else.
4. **What do you want to do?** Remove features, delete content an earlier trim left behind, or stop
   at the overview.
5. **After a removal, the content.** Delete it now or later. For a feature, later is the default:
   until the code is deployed, the live site may still ask for it, and the next `npm run trim` finds
   it by itself. When the only content is a language's, it is now, if `SANITY_API_EDIT_TOKEN` is
   set: the site ignores a language `LOCALES` does not serve either way, so waiting only leaves it
   listed in the Studio. Without the token it says so and leaves it for later. When a run leaves one
   locale, the asset text still stored per language (the seed's alt text included) counts too: the
   same purge flattens it to the plain string the media library then edits.

The flags below are for scripts and for skipping ahead; the guided run covers everything they do.

Full reference, including how to add a feature to the manifest:
[`scripts/trim-features/README.md`](../../scripts/trim-features/README.md).

## It knows what your project has

Two files split the knowledge:

- `scripts/trim-features/features.ts` is the **starter's** manifest: what each feature is made of,
  and the day it joined the starter. A project never edits it; `npm run trim:update` replaces it.
- `scripts/trim-features/project.json` is the **project's** record: the day it was cut from the
  starter, what it did with each feature, and the sections and document types it wrote itself.

From those two and the tree, every starter feature has one state:

| State | Meaning |
| --- | --- |
| present, partial | Here, all or in part. Offered by the trim |
| ported | Joined the starter after this project was cut, and the project took it anyway; offered like a present one |
| trimmed | Removed by the trim, which recorded it |
| removed | Gone by hand, before the trim or outside it |
| adopted | The project took it over and changed it; never offered, never asserted |
| never had | Joined the starter after this project was cut, so a file by its name is the project's own |

`npm run trim -- --status` prints that table, with each feature's content in **every** dataset
(production first) and any project code that imports it. Imported means used: removing it would break
that code, so the trim says so before it asks.

## Day one, and five weeks in

A new project is configured for English and Italian (`LOCALES` in `sanity/i18n.ts`), with seed
content in both. For an English-only site, run `npm run trim` right after the setup and pick Italian,
while nothing is live. The run then offers Translate with AI too, since it only works with a second
language; take it unless another language is coming. Turning it off later is the same run; the site stops serving Italian the moment
the code deploys, whether its content goes then or afterwards.

`npm run sanity:project-setup` stamps the cut date when it sets up a new project. From then on, plop
records every section or prefix-route type it scaffolds as the project's own, so `npm test` stays
green as the project grows.

A project that skipped the setup, or predates the record, runs this once:

```bash
npm run trim -- --reconcile
```

It asks when the project was cut (the fork point with the starter is the default, or the first
commit for a template copy), records what is gone, asks about each starter feature that was partly
removed or rewritten ("still the starter's, or yours now?"), and records the sections and types the
starter's manifest does not know as the project's.

A feature the starter shipped after your cut reads as "never had", even once you take it from the
starter by hand, so the trim would never offer it. Record it as ported and it counts as present: offered
for removal, and checked for edits your project has changed away.

```bash
npm run trim -- --reconcile --ported ai-translation
```

That writes `{ "state": "ported", "on": "<today>" }` for it in `project.json`. `--status` lists it as
ported, and a ported feature with none of its files left is reported until its entry goes.

## Keeping the trim current

The trim in a project is a copy. The starter keeps fixing and extending it, and a project picks that
up with:

```bash
npm run trim:update
```

It replaces the trim's files, skill and this doc with the starter's, and never touches what
`project.json` records. A feature the starter added after your cut shows up as "never had", so
nothing new is offered for removal that your project could not have.

A project that predates `trim:update` runs it once from a starter clone:
`node --import=tsx <starter>/scripts/trim-features/update.ts --from <starter>`.

## What ships as removable

| Id | What goes |
| --- | --- |
| `blog` | The blog index, articles, categories, the RSS feed, and the author profiles that byline them |
| `authors` | The same removal from the other side (see below) |
| `legal-pages` | The `legalPage` type and the prose route that renders it |
| `forms` | The shared form layer: validation, the Turnstile human check, the field components. Takes the contact form with it |
| `contact-form` | The section, the submissions inbox, and the Resend notification path |
| `announcement-bar` | The dismissible bar above the header, and its setting on the Site singleton |
| `umami` | The Umami tracking script, its website id, the event helpers and their skill, and its origins in the Report-Only CSP |
| `openapi` | `/openapi.json` and the links to it for agents. The JSON error shape stays |
| `media:mux`, `media:video-url`, `media:rive`, `media:lottie` | One media kind each: its option in the media field, its fields, its GROQ branch, its renderer and packages (and, for Mux, its origins in the Report-Only CSP) |
| `bootstrap` | The seed dataset and the Sanity setup wizard. Offered only once the project has a cut date, since until then they are how it starts |
| `language:it` | Italian as a site language: its `LOCALES` entry (commented out, not deleted) and its UI dictionary; with the dataset, every Italian document, its translation links and its text on shared documents and assets |
| `ai-translation` | Translate with AI: the document action and its dialog, the Settings > Translations panel and settings, the translate route, the daily AI request ledger, `npm run sanity:schema-check`, and the language migrations' Translate with AI steps; with the dataset, the `aiTranslation` record on every translated document and `siteSettings.translations` |
| `section:media`, `section:cta`, `section:text`, `section:contact-form`, `section:headline` | One page-builder section each |

Italian leaves the i18n code itself in place: with one locale configured it switches off by itself,
and turning a language back on is one uncomment plus `npm run sanity:add-language`. After a trim,
that also means restoring `src/features/i18n/dictionaries/it.ts` from the starter and deleting the
`language:it` entry in `project.json`. A language a project added itself is not in the manifest:
comment its line out of `LOCALES` and delete its dictionary, and `npm run trim` offers its content.

`ai-translation` is offered, never implied, when a run switches a language off and leaves one locale: it only works beside a second
language, but a project may keep it for a language it plans to add. A two-language project can remove it
on its own. Automatic alt text stays either way: without the ledger each description is one direct call,
counted against no daily limit. The `aiTranslation.*` bookkeeping documents (leases, the ledger, saved
results) have dotted ids, so no purge reaches them; the closing report says how to delete them.

`blog` and `authors` imply each other. A person only exists as an article's author, and the byline is
part of the article route and its JSON-LD, so "a blog without bylines" would mean rewriting that route
rather than unwiring a registry. `forms` implies `contact-form` one way only: a project can drop the
contact form and keep the layer to build its own forms.

## It expects a project that has been worked in

By the time you decide you never needed the blog, queries have extra fields and routes have been
edited around. So the trim resolves every edit against the tree first, and if some no longer apply it
says which, and offers to do the rest and leave those to you. `npm run check` then fails on exactly
those spots, so the type errors are your checklist. With `--yes` it stops instead, unless you add
`--partial`: a scripted run should not quietly do most of a job.

Commit or stash first: the undo is `git checkout .`, and the script refuses a dirty tree for that
reason. It also refuses a shell whose Node or npm is outside `package.json`'s `engines`, because the
install it runs after deleting files would fail there; `nvm use` fixes it.
`npm run trim -- --dry-run --feature <id>` prints every file it will delete and every edit it will
make.

## The dataset is a separate decision

The trim **reads** the datasets and prints what each feature holds before it asks anything. Drafts
and documents waiting in a content release count too, each shown beside the published number. It
deletes nothing unless you add `--dataset`, which has its own confirmation, exports the dataset to
`./backups/` first, and deletes every document of the removed types, drafts and release versions
included, in one transaction.

```bash
npm run trim -- --feature blog --dataset
```

The purge needs `SANITY_API_EDIT_TOKEN`, because deleting and patching documents cannot be expressed
as Sanity CLI commands, and a logged-in Sanity CLI for the export. Both are checked before anything
is exported, as is everything else that would make Sanity refuse the purge: a strong reference from a
document that stays, or a version in a scheduled release. After the export the plan is made again
from what the dataset holds, and nothing is written if it grew. Purge production only after the code
trim is deployed, or the live site queries content that is already gone.

Translation links go with what they link: every purge repairs the translation groups its documents
belong to, or deletes a group left with fewer than two, in the same transaction as the deletes.

A scripted (`--yes`) purge of the dataset named in `.env` refuses to run unless
`--allow-live-target <that name>` repeats it, the same rule as `sanity:dataset-migrate`; the refusal
prints the project and dataset, and nothing is changed. Interactive runs confirm instead, naming
both the project and the dataset.

### You can purge later, in any project

The two halves are usually days apart, so the purge is not a one-shot. Run `npm run trim` once the
code is deployed: it lists what each dataset still holds that the schema no longer declares, and
offers to delete it. For a script:

```bash
npm run trim -- --dataset-only --dry-run   # read-only: what is stranded?
npm run trim -- --dataset-only             # pick from it and delete
```

This half **reads no manifest**. A `_type` with documents but no entry in `sanity-schema.json` cannot
be rendered, queried by the app, or opened in the Studio, and a page-builder item whose type the
schema no longer declares is skipped by the site and flagged in the Studio. So it diffs the extracted
schema against what the dataset stores: whole documents, and section items inside pages. Any type whose name contains a dot is excluded, because a plugin owns
it and may write documents at runtime that the extract never mentions. Run it once per dataset.

Fields are the one thing it needs a name for, since nothing lists the keys a document stores. A
feature that adds a field to a document that stays, like the announcement on the Site singleton,
declares it, and the field is offered for unsetting once the extracted schema stops declaring it.

Languages are judged by `sanity/i18n.ts` instead. Anything stored in a language `LOCALES` does not
configure is offered: its documents (published, drafts and release versions), its translation links,
its text on shared documents such as category names, and its asset text, which is flattened back to
one string once a single locale is left. Text left after the documents went still counts, so a run
can be cleanup only. `npm run trim -- --status` lists it as content in languages this site does not
serve, the same name the Studio uses.

```bash
npm run trim -- --dataset-only --language it   # Italian content left behind
npm run trim -- --dataset-only --language      # only text left in other languages
```

### Why it matters that you do

Routes are file-based, so a code-only trim is already enough for `/blog` to answer a real `404`. The
sitemap is the part that costs you. It selects **every** document with a `uri.current`, with no
filter on type:

```
*[defined(uri.current) && seoMetadata.noIndex != true && passwordProtected != true]
```

So after a code-only trim of the blog, `/sitemap.xml` still lists `/blog`, every article and every
author, and every one of those URLs now 404s. Search engines read that sitemap.

A language is the exception. The site ignores content in a language `LOCALES` does not serve on
every page, the sitemap, the feed and the agent endpoints, from the first request after the deploy.
What is left until the purge is the Studio listing it, and the closing report says so.

## What it deliberately leaves alone

It removes; it does not repair. The closing report lists what is left:

- **Prose.** Docs, skills and tests that still name the feature are listed by file and line: its
  files, the names they export, the API routes it served, and its prose names. The trim prunes links
  to a deleted doc, but a sentence explaining the feature is yours to rewrite. A language is the
  exception: docs and tests use Italian and `/it/` as their example second language, which stays
  accurate, so only the sentences saying the starter is configured for "English and Italian" are
  listed.
- **Shared code it was the last user of.** A layer like the Marquee behind the announcement bar is
  listed once nothing else imports it, and left for you to decide on.
- **Nested media.** A media item is an object inside a page, section or rich text, so no purge reaches
  it. One set to a trimmed media kind renders nothing until an editor picks another.
- **Dangling weak references.** `internal.link` is `weak: true`, so a footer link to a deleted legal
  page survives as a `_ref` to nothing. Every holder is listed in the purge plan.
- **Orphaned section anchors.** `internal.sectionTarget` stores a section's `_key` as a plain string,
  so nothing in Sanity flags it. The report covers a section's own `appLink`; an anchor written into
  a rich text annotation is not reachable by GROQ, so treat the report as a floor.
- **Stale generated Markdown.** `agentMarkdown.content` and `siteSettings.llms.content` are stored
  verbatim. Regenerate them from the Agents tab. See [Agent Markdown](./agent-markdown.md) and
  [llms.txt and AI agents](./llms-txt.md).
- **A language's way back.** Its `LOCALES` line stays, commented out, and `SECTION_SEGMENTS` keeps
  its section words. The bundled seed is not edited: the setup wizard and `npm run sanity:dataset-import`
  leave out a language `LOCALES` does not configure.
- **Redirects for a language.** Its indexed URLs answer 404 once it is off. The report suggests a 301
  from each to its default-language sibling, from the translation links, and lists Settings redirects
  that now land on a 404. Nothing is written: add them in Settings > Redirects, publish, redeploy.
- **The deployed schema.** It still declares the removed language's fields, which Agent Actions read,
  until `npm run sanity:schema-deploy` runs after the deploy.

## When it refuses to start

> ❌ The manifest does not describe this repository, so nothing was changed.

The shared registries the manifest is written around (`sanity/schemas/index.ts` and the like) are not
where it looks, so the tree was restructured rather than trimmed. Read the `--dry-run` plan as a
specification and apply it by hand.

> ❌ That selection would not leave a working starter, so nothing was changed.

Removing every page-builder section left on disk, the project's own included. Each edit is valid on
its own, but a page builder with nothing to build from breaks the Studio and the build. The same
refusal covers the default locale: changing it is a URI rewrite, not a removal.

> ❌ Not something this run can remove, so nothing was changed.

The feature is already trimmed, removed, adopted, or one this project never had. The message says
which.

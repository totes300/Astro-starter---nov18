# Seed dataset (starter content)

The repo ships a small **seed dataset** at [`seed/seed-dataset.tar.gz`](../../seed/) so a freshly cloned project starts with real example content instead of an empty Studio.

## What's in it

A standard Sanity dataset export with:

- example **pages** and **legal pages**
- the **`site`** singleton (header, footer, SEO defaults) and the **`siteSettings`** singleton (site-wide configuration)
- the **`blog`** index singleton plus its example **articles**, **article categories**, and the **`person`** they are bylined to
- the **image and file assets** they reference (about 5 MB total)
- content in two languages: every English document of a translated type has a published Italian translation made with **Translate with AI** and proofread, linked to it through a **`translation.metadata`** group, and category names and image alt text are `{ en, it }` objects (see [Languages](#languages))
- agent Markdown stored for every routed page and an llms.txt covering both languages, with root-relative page links; the image URLs in the Markdown point at the CDN of the project the seed was exported from until **Generate** in a page's **Agents** tab rewrites them

### The seeded site starts public

The seed's `siteSettings` ships with **Protect entire site** off and no page password-protected, so a fresh seeded deploy serves every page without credentials. To gate a pre-launch site, set `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` as Worker secrets (`npx wrangler secret put`, see [Deployment](../deployment.md)) and switch **Settings** → **Security** → **HTTP Basic Auth** → **Protect entire site** on. While it is on, `/llms.txt` and `/openapi.json` answer `404`, and `/sitemap.xml` answers `401` without the Basic Auth credentials. See [Basic Authentication](../features/basic-auth.md).

### Automatic alt text starts off

**Settings** → **Agents** → **Automatic alt text** → **Describe new uploads** ships off: every image described uses your Sanity organization's AI credits, with one AI request per configured language, and a fresh clone uploads plenty while the site is built. Switch it on when you want it; the Backfill button in the same panel works either way. See [Automatic alt text](../features/auto-alt-text.md). `scripts/sanity-dataset/seed.test.ts` fails on a seed that ships it on.

`npm run sanity:project-setup` imports it for you at the end of its run; `npm run sanity:dataset-import` imports it on demand, and the `sanity:cli` export command below refreshes it.

## Seed a new project

Nothing to run: [`npm run sanity:project-setup`](./project-setup.md) asks how the dataset should start and, on the default answer for a new project, imports this archive with `--replace` right after it writes `.env`. For an existing project the default is to import nothing, because the seed replaces the live `site`, `siteSettings`, `homepage` and `blog`, and with Italian configured adds its own Italian copies and translation groups beside any the dataset already has; choosing the seed there takes the dataset name typed back, and a dataset that is not private gets one more question (default no). So the first run is:

```bash
npm run sanity:project-setup   # create project, tokens, CORS, .env, seed content
npm run sanity:typegen         # generate sanity/types.ts
npm run dev
```

## Seed it separately

Answered **Completely empty**, or seeding a second dataset? With an authenticated CLI (`npm run sanity:cli -- login`):

```bash
npm run sanity:dataset-import -- --file seed/seed-dataset.tar.gz
```

Or run `npm run sanity:dataset-import` with no flags and pick the seed from the list. It then asks which dataset to import into, with the `.env` one offered first; pass `--dataset <name>` to answer that up front, or `--replace` to overwrite existing documents. With `--yes`, `--replace` needs `--dataset` (plus `--allow-live-target <name>` when that is the `.env` dataset), and a public target needs `--allow-public` (see [Dataset export and migration](./dataset-migration.md#safety-notes)).

The import keeps only the languages your `sanity/i18n.ts` configures; see [Languages](#languages).

## Languages

The committed seed pairs each English document of a translated type (the homepage, the About page, both legal pages, the blog index, both articles and the Site) with a published Italian translation, made with Translate with AI and then proofread, linked to it through a `translation.metadata` group. It is in the shapes the language migrations give a dataset: every translated document carries its `language`, and a category's `name`, the author's role, bio, SEO text and agent Markdown, and the image alt text are `{ en, it }` objects. The author is one shared `person` that both languages' articles reference. Each Italian document carries an `aiTranslation` record stamped after the proofreading, so the Studio reads it as translated by AI and up to date. With one language configured, the import leaves the Italian out and flattens the asset text back to plain strings, which is what the media library then edits (see below). A dataset seeded before these shapes is still read as it is, plain strings included; [Internationalization](../features/internationalization.md#existing-content-and-migrations) lists the migrations that bring it up to date.

A seed refreshed from a dataset that runs more than one language can hold:

- one document per language for each translated type (`I18N_DOCUMENT_TYPES` in `sanity/constants.ts`), each with its `language`;
- the `translation.metadata` groups that link a document to its translations;
- shared fields translated in place (`LOCALIZED_FIELDS`, such as a category's `name`) as one object with a text per language;
- asset text (alt text, title, description, credit line) as one object with a text per language.

`npm run sanity:dataset-import`, and the setup wizard's seed step, narrow the bundled seed to the languages `LOCALES` in `sanity/i18n.ts` configures before they import anything, so a project that switched a language off (for example with `npm run trim`) never gets that language back from the seed. It runs the same plan `npm run trim` uses to delete a language from a dataset:

- documents in any other language are left out, with every translation group that no longer links two documents;
- shared fields and asset text keep only the configured languages, and with one locale left, asset text becomes that locale's plain string, which is what the media library edits then;
- the stored llms.txt loses every entry that links into a language left out, and any section that leaves empty;
- a kept document that **strongly** references one that is left out stops the import before anything is written; a weak link to one is reported, since it would point nowhere.

The summary names what is left out under **Languages**, and `--dry-run` shows it without importing. The filtered copy is written to a temporary folder and deleted afterwards; the committed archive never changes. Only `seed/seed-dataset.tar.gz` is filtered: a backup from `./backups`, or any other archive, restores exactly as it was exported.

## Refresh the seed

When you change the demo content and want the committed seed to match:

```bash
npm run sanity:cli -- dataset export production seed/seed-dataset.tar.gz \
  --types page,legalPage,site,siteSettings,blog,article,articleCategory,person,translation.metadata,sanity.imageAsset,sanity.fileAsset --overwrite
```

Export from a dataset that has run `npm run sanity:migrate-backfill-language`, `npm run sanity:migrate-localize-fields` and, with more than one language configured, `npm run sanity:migrate-asset-fields`, so every translated document carries its language and every shared field is an object of texts. Every language the dataset holds goes into the seed, and an import keeps only the ones the project configures. `translation.metadata` is in the list because the translations are linked through it; leave it out and the seed loses every link between a document and its translations.

The committed `seed/seed-dataset.tar.gz` is tracked in git via a `.gitignore` exception, even though `*.tar.gz` is otherwise ignored.

**Security note:** a full dataset export includes **every** document, including secret-bearing ones. In this project that means the Mux config document (`mux.apiKey`), which stores a private signing key and access token. The `--types` allowlist above is what keeps secrets out of the committed seed: it exports only content types (pages, legal pages, the blog with its articles, categories and author, the `site` and `siteSettings` singletons, the translation groups, and image/file assets). Keep that list, and extend it when you add new content document types. `npm test` runs `scripts/sanity-dataset/seed.test.ts` against the committed archive. It checks that every reference resolves (so a referenced type missing from the list fails there instead of at import), and it fails when the seed holds:

- a `_type` outside the same allowlist (the test keeps its own copy; extend both together)
- a secret-bearing document: `sanity.previewUrlSecret`, `sanity.previewUrlShareAccess`, `sanity.secrets`, any `mux.*` or `secrets.*` document, or a `contactFormSubmission`
- a dotted `_id` (`drafts.`, `versions.` or any other non-root document)
- a second copy of the `site`, `siteSettings` or `blog` singleton, or one whose `_id` is not its type name. A singleton's translation is the exception: at most one per other language, linked to the `_id`-named document by its `translation.metadata` group, and that document itself is in the default language
- a field named like a token, secret, password or API key that holds a string
- metadata a hand repack adds: an AppleDouble `._` entry, a `com.apple.*` extended attribute, or the packing account's name or ids in an entry's owner fields (pack with `COPYFILE_DISABLE=1 tar --no-xattrs --uid 0 --gid 0 --numeric-owner`, see [`seed/README.md`](../../seed/README.md)).

It also checks the languages, against `LOCALES` active **and** commented out, so a project that switched a language off keeps a valid seed:

- a translated document with no `language` (an empty string counts as none), or any `language` that `LOCALES` does not list;
- a `translation.metadata` group that links fewer than two documents, links a document that is not in the seed, links two in one language, says a language its document does not carry, or uses a `_key` no patch path can name; and a document linked by two groups;
- a `LOCALIZED_FIELDS` value that is a plain string, lacks its default-language text, or holds a language `LOCALES` does not list, and asset text in such a language;
- the seed narrowed to the default language alone (what an English-only import receives) must still pass every check above, keep every strong reference resolvable, leave no weak link dangling and lose no asset text.

A seed exported before any document carried a language (no `language` and no `translation.metadata` anywhere) still imports, but the language checks then report as a TODO in `npm test` until the seed is refreshed from a backfilled dataset. The committed seed carries languages, so every check runs.

The same caution applies to full backups from [`npm run sanity:dataset-export`](./dataset-migration.md): treat those archives as sensitive and never commit or share them.

See also: [Dataset export and migration](./dataset-migration.md), [Sanity project setup](./project-setup.md).

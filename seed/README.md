# Seed dataset

Starter content that ships with the template so a freshly cloned project boots with example data instead of an empty Studio.

`seed-dataset.tar.gz` is a standard Sanity dataset export containing:

- example **pages**
- the **`site`** singleton (header, footer, SEO defaults) and the **`siteSettings`** singleton (site-wide configuration)
- the **`blog`** index singleton plus its example **articles**, **article categories**, and the **`person`** they are bylined to
- the **image and file assets** they reference (about 5 MB total)
- content in two languages: every English document of a translated type has a published Italian translation made with **Translate with AI** and proofread, linked to it through a **`translation.metadata`** group, and category names, the author's role, bio, SEO text and agent Markdown, and image alt text are `{ en, it }` objects (the author is one shared person) (see [Languages](../docs/sanity/seed-dataset.md#languages))

The seeded site starts public: `siteSettings` ships with **Protect entire site** off and no page is password-protected, so a fresh project boots without any credentials. Turn protection on in **Settings** → **Security** → **HTTP Basic Auth** when you need it; see [Basic Authentication](../docs/features/basic-auth.md).

Automatic alt text starts off too: each image it describes uses your Sanity organization's AI credits, with one AI request per configured language. Switch it on in **Settings** → **Agents** → **Automatic alt text** when you want it; see [Automatic alt text](../docs/features/auto-alt-text.md).

## Import it (seed your dataset)

[`npm run sanity:project-setup`](../docs/sanity/project-setup.md) already does this: its last question asks how the dataset should start, and the default answer imports this archive with `--replace`.

To import it separately (you answered **Completely empty**, or you are seeding another dataset), with the CLI authenticated (`npm run sanity:cli -- login`):

```bash
npm run sanity:dataset-import -- --file seed/seed-dataset.tar.gz
```

Or run `npm run sanity:dataset-import` with no flags and pick the seed from the list. It then asks which dataset to import into, with the `.env` one offered first; pass `--dataset <name>` to answer that up front, or `--replace` to overwrite existing documents.

The import keeps only the languages `LOCALES` in `sanity/i18n.ts` configures: documents in any other language, their translation groups and their text on shared fields and assets are left out of what reaches the dataset, and this archive never changes. See [Languages](../docs/sanity/seed-dataset.md#languages).

## Refresh it (template authors)

To regenerate this archive from your own content:

```bash
npm run sanity:cli -- dataset export production seed/seed-dataset.tar.gz \
  --types page,legalPage,site,siteSettings,blog,article,articleCategory,person,translation.metadata,sanity.imageAsset,sanity.fileAsset --overwrite
```

Export from a dataset where every translated document carries its language (`npm run sanity:migrate-backfill-language`) and every shared field is an object of texts (`npm run sanity:migrate-localize-fields`); `npm test` checks both.

To edit the export by hand (say, one setting in `data.ndjson`) and pack it again on macOS, keep the system's metadata out of the archive: `COPYFILE_DISABLE=1` stops `tar` adding an AppleDouble `._` file per entry, `--no-xattrs` drops the extended attributes (`com.apple.provenance` and the like), and `--uid 0 --gid 0 --numeric-owner` stops it writing your account's name and ids into every entry (GNU tar: `--owner=0 --group=0 --numeric-owner`):

```bash
COPYFILE_DISABLE=1 tar --no-xattrs --uid 0 --gid 0 --numeric-owner -czf seed/seed-dataset.tar.gz production-export-<timestamp>
```

`scripts/sanity-dataset/seed.test.ts` (`npm test`) fails on any of the three.

**Security note:** a full dataset export includes **every** document, secrets and personal data included. In this project that means the Mux config document (`mux.apiKey`), which stores a private signing key and access token, the preview URL secrets, and contact form submissions. The `--types` allowlist above is what keeps them out of the committed seed: it exports only content types (pages, the `site` and `siteSettings` singletons, the translation groups, and image/file assets). Keep that list and extend it when you add new content types. `npm test` checks that every reference in the archive resolves, so a referenced type missing from the list fails there instead of at import. `scripts/sanity-dataset/seed.test.ts` (also `npm test`) fails on any type outside the allowlist and on any secret-bearing or dotted-id document (`sanity.previewUrl*`, `sanity.secrets`, `mux.*`, `secrets.*`, `contactFormSubmission`, `drafts.`, `versions.`), and on languages that do not line up (see [the full list](../docs/sanity/seed-dataset.md#refresh-the-seed)). It keeps its own copy of the allowlist (`SEED_TYPE_ALLOWLIST`), so extend it together with `--types`. The same caution applies to full backups from `npm run sanity:dataset-export`: treat those archives as sensitive and never commit or share them.

Full reference: [`docs/sanity/seed-dataset.md`](../docs/sanity/seed-dataset.md).

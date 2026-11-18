# Code Generation (Plop)

This starter uses [Plop](https://plopjs.com/) to scaffold page builder sections, prefix page routes, and rich text blocks with consistent structure.

## Usage

Run:

```bash
npm run plop
```

Then choose one of the available generators and provide the requested inputs. The generators and templates live in `plopfile.mjs` and `templates/`.

Every generator changes the schema, and none deploys it. Run `npm run sanity:schema-deploy` once the new type or block is in, and with the deploy that ships it. Until then a prefix route's new document type stops every Translate with AI run, not only for that type (`schema_drift`), and a new section or rich text block is translated against a deployed schema that lacks it (see [Deployment](../deployment.md#deploy-the-schema-with-schema-changes)).

## What Gets Generated

### Page Builder Section

- Schema file in `sanity/schemas/page-sections/`
- Component file at `src/features/page-builder/sections/{PascalName}.astro`
- Section query added to `src/features/page-builder/queries.ts`
- Automatic registration in `src/features/page-builder/PageSections.astro` and the schema index
- Runs `npm run sanity:typegen` and Biome format via `plopfile.mjs`

### Prefix Page Route

- Schema file in `sanity/schemas/documents/`, with the hidden `language` field
- Schema registration in `sanity/schemas/index.ts`
- Studio structure entry in `sanity/structure.tsx`, one list per language
- Translated type registration in `I18N_DOCUMENT_TYPES` (`sanity/constants.ts`)
- Its conditionally hidden copy (the SEO title and description) in `CONDITIONAL_PATHS` (`sanity/ai-translation/fields.ts`), so [Translate with AI](./ai-translation.md) opens them; skipped in a project without it
- Its own Translate with AI run step: `RUN_ORDER` (`sanity/ai-translation/plan.ts`), its group title in `SITE_GROUP_TITLES` (`site-run.ts`, the route prefix in sentence case) and `OWN_SLUG_STEPS` (`dialog-model.ts`), so a whole-site run orders and groups it as itself and a translation takes a slug from its title; skipped in a project without it
- Section registration in `sanity/sections.ts` (its URL word per language and its document type)
- Route file at `src/pages/{prefix}/[slug].astro`, in the page's language: its hreflang alternates, `lang` and `translations` for the language switcher (see [Internationalization](./internationalization.md#the-route-recipe))
- Route query added to `src/sanity/queries.ts`, carrying the ghost guard (`${ConfiguredLocaleFilter}`) and projecting `${LocaleField}`, `noIndex` and `${AlternatesFragment}`
- Runs `npm run sanity:typegen` and Biome format via `plopfile.mjs`

This generator scaffolds routes like `/{prefix}/{slug}` (for example `/articles/my-post`) and wires a matching Sanity document type.

### Rich Text Block

- Schema file in `sanity/schemas/fields/create-rich-text/blocks/`
- Component file at `src/sanity/rich-text/components/{PascalName}.astro`
- GROQ fragment at `src/features/rich-text/blocks/{kebab-name}/fragment.ts`
- Automatic registration in `SanityRichText.astro`, `src/features/rich-text/fragment.ts`, and the schema block index
- Runs `npm run sanity:typegen` and Biome format via `plopfile.mjs`

## Why Use It

- Consistent patterns across the codebase
- Less boilerplate work
- Fewer manual registration mistakes

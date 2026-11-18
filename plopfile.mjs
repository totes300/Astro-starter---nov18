import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export default function run(
  /** @type {import('plop').NodePlopAPI} */
  plop
) {
  plop.setActionType("runCommand", (answers, config) => {
    const command = plop.renderString(config.command, answers);

    return new Promise((resolve, reject) => {
      exec(command, (error) => {
        if (error) {
          reject(error.message);
        } else {
          resolve(command);
        }
      });
    });
  });

  plop.setHelper("removeSectionSuffix", (text) => {
    return text.replace(/\s*section$/i, "");
  });

  plop.setHelper("removeBlockSuffix", (text) => {
    return text.replace(/\s*block$/i, "");
  });

  // A Translate with AI registry: skipped where a trim removed it, and where it already lists the type.
  const unlessListed = (file, registry, marker, entry) => (answers) => {
    const path = join(plop.getDestBasePath(), file);

    if (!existsSync(path)) {
      return `Translate with AI is not in this project, so it has no ${registry} to fill`;
    }

    // A type a trim or a hand edit removed may still be listed, and a second entry would repeat a key or a step.
    const source = readFileSync(path, "utf8");
    const listed = source.slice(source.indexOf(registry), source.indexOf(marker));
    const line = plop.renderString(entry, answers);

    return new RegExp(`^\\s*${line}`, "m").test(listed) ? `${registry} already lists ${line}` : undefined;
  };

  plop.setGenerator("Page Builder Section", {
    description: "Create a new page builder section",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Name (section names will automatically be suffixed with 'Section'. eg. 'cta' -> 'ctaSection')",
        filter: (val) => `${val} Section`,
      },
    ],
    actions: [
      {
        type: "add",
        path: "./sanity/schemas/page-sections/{{kebabCase name}}.tsx",
        templateFile: "templates/page-builder-section/schema.tsx.hbs",
      },
      {
        type: "modify",
        path: "./sanity/schemas/page-sections/index.ts",
        pattern: /(\/\/ PLOP: Add Import)/g,
        template: `import { {{camelCase name}} } from "./{{kebabCase name}}";\n$1`,
      },
      {
        type: "modify",
        path: "./sanity/schemas/page-sections/index.ts",
        pattern: /(\/\/ PLOP: Add Export)/g,
        template: `{{camelCase name}},\n  $1`,
      },
      {
        type: "add",
        path: "src/features/page-builder/sections/{{pascalCase name}}.astro",
        templateFile: "templates/page-builder-section/component.astro.hbs",
      },
      {
        type: "modify",
        path: "src/features/page-builder/queries.ts",
        pattern: /(\/\/ PLOP: Add Section Query)/g,
        templateFile: "templates/page-builder-section/query.ts.hbs",
      },
      {
        type: "modify",
        path: "src/features/page-builder/PageSections.astro",
        pattern: /(\/\/ PLOP: Add Import)/g,
        template: `import {{pascalCase name}} from './sections/{{pascalCase name}}.astro'\n$1`,
      },
      {
        type: "modify",
        path: "src/features/page-builder/PageSections.astro",
        pattern: /(\/\/ PLOP: Add Export)/g,
        template: `{{camelCase name}}Field: {{pascalCase name}},\n  $1`,
      },
      {
        type: "runCommand",
        abortOnFail: false,
        description: "Record it as this project's own, so the trim leaves it be",
        command: "node --import=tsx scripts/trim-features/own.ts section {{pascalCase name}}",
      },
      {
        type: "runCommand",
        abortOnFail: true,
        description: "Generate types",
        command: "npm run sanity:typegen",
      },
      {
        type: "runCommand",
        abortOnFail: false,
        description: "Format code",
        command: "npm run format",
      },
    ],
  });

  plop.setGenerator("Prefix Page Route", {
    description:
      "Create a prefix route /{prefix}/{slug} (e.g. /articles/my-post). Route prefix = URL segment (plural). Document type = Sanity schema name (singular).",
    prompts: [
      {
        type: "input",
        name: "routePrefix",
        message: "Route prefix, plural (e.g. articles). URL will be /{prefix}/{slug}",
        validate: (val) => {
          const trimmed = typeof val === "string" ? val.trim() : "";
          return trimmed.length > 0 ? true : "Route prefix is required. You cannot proceed without it.";
        },
        filter: (val) => (typeof val === "string" ? val.trim() : val),
      },
      {
        type: "input",
        name: "documentType",
        message: "Document type name, singular (e.g. article). Sanity schema and _type",
        validate: (val) => {
          const trimmed = typeof val === "string" ? val.trim() : "";
          return trimmed.length > 0 ? true : "Document type is required. You cannot proceed without it.";
        },
        filter: (val) => (typeof val === "string" ? val.trim() : val),
      },
    ],
    actions: [
      {
        type: "add",
        path: "./sanity/schemas/documents/{{kebabCase documentType}}.tsx",
        templateFile: "templates/page-route/schema.tsx.hbs",
        data: (answers = {}) => ({
          ...answers,
          basePath: answers.routePrefix ?? "",
        }),
      },
      {
        type: "modify",
        path: "./sanity/schemas/index.ts",
        pattern: /(\/\/ PLOP: Add Import)/,
        template: 'import { {{camelCase documentType}} } from "./documents/{{kebabCase documentType}}";\n$1',
      },
      {
        type: "modify",
        path: "./sanity/schemas/index.ts",
        pattern: /(\/\/ PLOP: Add Export)/,
        template: "{{camelCase documentType}},\n  $1",
      },
      {
        type: "modify",
        path: "./sanity/structure.tsx",
        pattern: /(\/\/ PLOP: Add Structure)/,
        templateFile: "templates/page-route/structure.tsx.hbs",
      },
      {
        type: "modify",
        path: "./sanity/constants.ts",
        pattern: /(\/\/ PLOP: Add Translated Type)/,
        template: '"{{camelCase documentType}}",\n  $1',
      },
      {
        type: "modify",
        path: "./sanity/ai-translation/fields.ts",
        pattern: /(\/\/ PLOP: Add Conditional Paths)/,
        // The schema template's only conditionally hidden copy is its SEO title and description.
        template: "{{camelCase documentType}}: SEO_TEXT,\n  $1",
        skip: unlessListed(
          "sanity/ai-translation/fields.ts",
          "CONDITIONAL_PATHS",
          "// PLOP: Add Conditional Paths",
          "{{camelCase documentType}}:"
        ),
      },
      {
        type: "modify",
        path: "./sanity/ai-translation/plan.ts",
        pattern: /(\/\/ PLOP: Add Run Step)/,
        // Its own step, with what pages link to, so a whole-site run neither orders nor groups it as another type.
        template: '"{{camelCase documentType}}",\n  $1',
        skip: unlessListed(
          "sanity/ai-translation/plan.ts",
          "RUN_ORDER",
          "// PLOP: Add Run Step",
          '"{{camelCase documentType}}",'
        ),
      },
      {
        type: "modify",
        path: "./sanity/ai-translation/site-run.ts",
        pattern: /(\/\/ PLOP: Add Site Group Title)/,
        template: '{{camelCase documentType}}: "{{sentenceCase routePrefix}}",\n  $1',
        skip: unlessListed(
          "sanity/ai-translation/site-run.ts",
          "SITE_GROUP_TITLES",
          "// PLOP: Add Site Group Title",
          "{{camelCase documentType}}:"
        ),
      },
      {
        type: "modify",
        path: "./sanity/ai-translation/dialog-model.ts",
        pattern: /(\/\/ PLOP: Add Own Slug Step)/,
        // The route serves `/{prefix}/{slug}` and the schema slugifies the title, so a translation gets its own slug.
        template: '"{{camelCase documentType}}",\n  $1',
        skip: unlessListed(
          "sanity/ai-translation/dialog-model.ts",
          "OWN_SLUG_STEPS",
          "// PLOP: Add Own Slug Step",
          '"{{camelCase documentType}}",'
        ),
      },
      {
        type: "modify",
        path: "./sanity/sections.ts",
        pattern: /(\/\/ PLOP: Add Section Segment)/,
        template: '"{{kebabCase routePrefix}}": {},\n  $1',
      },
      {
        type: "modify",
        path: "./sanity/sections.ts",
        pattern: /(\/\/ PLOP: Add Section Types)/,
        template: '"{{kebabCase routePrefix}}": { item: "{{camelCase documentType}}" },\n  $1',
      },
      {
        type: "add",
        path: "src/pages/{{kebabCase routePrefix}}/[slug].astro",
        templateFile: "templates/page-route/page.astro.hbs",
        data: (answers = {}) => ({
          ...answers,
          basePath: answers.routePrefix ?? "",
        }),
      },
      {
        type: "modify",
        path: "src/sanity/queries.ts",
        pattern: /(\/\/ PLOP: Add Route Query)/,
        templateFile: "templates/page-route/queries.ts.hbs",
        // The blog trim drops the other `SeoFunctions` user, and Biome then drops the import with it.
        transform: (contents) =>
          /import\s*\{[^}]*\bSeoFunctions\b[^}]*\}\s*from "~\/features\/site\/seo\/fragment"/.test(contents)
            ? contents
            : `import { SeoFunctions } from "~/features/site/seo/fragment";\n${contents}`,
      },
      {
        type: "runCommand",
        abortOnFail: false,
        description: "Record it as this project's own, so the trim leaves it be",
        command: "node --import=tsx scripts/trim-features/own.ts type {{camelCase documentType}}",
      },
      {
        type: "runCommand",
        abortOnFail: true,
        description: "Generate types",
        command: "npm run sanity:typegen",
      },
      {
        type: "runCommand",
        abortOnFail: false,
        description: "Format code",
        command: "npm run format",
      },
    ],
  });

  plop.setGenerator("Rich Text Block", {
    description: "Create a new rich text block",
    prompts: [
      {
        type: "input",
        name: "name",
        message: "Name (block names will automatically be suffixed with 'Block'. eg. 'cta' -> 'ctaBlock')",
        filter: (val) => `${val} Block`,
      },
    ],
    actions: [
      {
        type: "add",
        path: "./sanity/schemas/fields/create-rich-text/blocks/{{kebabCase name}}.tsx",
        templateFile: "templates/rich-text-block/schema.tsx.hbs",
      },
      {
        type: "modify",
        path: "./sanity/schemas/fields/create-rich-text/blocks/index.ts",
        pattern: /(\/\/ PLOP: Add Import)/g,
        template: `import { {{camelCase name}} } from "./{{kebabCase name}}";\n$1`,
      },
      {
        type: "modify",
        path: "./sanity/schemas/fields/create-rich-text/blocks/index.ts",
        pattern: /(\/\/ PLOP: Add Export)/g,
        template: `{{camelCase name}},\n$1`,
      },
      {
        type: "add",
        path: "src/sanity/rich-text/components/{{pascalCase name}}.astro",
        templateFile: "templates/rich-text-block/component.astro.hbs",
      },
      {
        type: "add",
        path: "src/features/rich-text/blocks/{{kebabCase name}}/fragment.ts",
        templateFile: "templates/rich-text-block/fragment.ts.hbs",
      },
      {
        type: "modify",
        path: "src/sanity/rich-text/SanityRichText.astro",
        pattern: /(\/\/ PLOP: Add Block Import)/g,
        template: `import {{pascalCase name}} from './components/{{pascalCase name}}.astro'\n$1`,
      },
      {
        type: "modify",
        path: "src/sanity/rich-text/SanityRichText.astro",
        pattern: /(\/\/ PLOP: Add Block Render)/g,
        template: `{{camelCase name}}: {{pascalCase name}},\n    $1`,
      },
      {
        type: "modify",
        path: "src/features/rich-text/fragment.ts",
        pattern: /(\/\/ PLOP: Add Import)/g,
        template: `import { {{pascalCase name}}Fragment } from "./blocks/{{kebabCase name}}/fragment";\n$1`,
      },
      {
        type: "modify",
        path: "src/features/rich-text/fragment.ts",
        pattern: /(\/\/ PLOP: Add Export)/g,
        template: "${ {{pascalCase name}}Fragment },\n  $1",
      },
      {
        type: "runCommand",
        abortOnFail: true,
        description: "Generate types",
        command: "npm run sanity:typegen",
      },
      {
        type: "runCommand",
        abortOnFail: false,
        description: "Format code",
        command: "npm run format",
      },
    ],
  });
}

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { apiRouteOf, findFeature } from "./features";
import { exportedNames, findMentions, formatMentions, mentionTerms } from "./mentions";

test("mentionTerms keeps distinctive names and drops words that would match any prose", () => {
  const forms = findFeature("forms");

  assert.ok(forms);

  const terms = mentionTerms(forms);

  assert.ok(terms.includes("Turnstile"));
  assert.ok(terms.includes("SubmitButton"));
  assert.ok(terms.includes("form layer"));
  assert.ok(!terms.includes("Form"));
  assert.ok(!terms.includes("forms"));
});

test("mentionTerms adds the spaced form of a hyphenated name, which is how prose writes it", () => {
  const announcement = findFeature("announcement-bar");

  assert.ok(announcement);
  assert.ok(mentionTerms(announcement).includes("site announcement"));
});

test("mentionTerms quotes document types, so `article` matches and the word article does not", () => {
  const blog = findFeature("blog");

  assert.ok(blog);
  assert.ok(mentionTerms(blog).includes("`article`"));
});

test("mentionTerms reads every file a feature deletes: inner names, distinctive exports and API routes", () => {
  const forms = findFeature("forms");

  assert.ok(forms);

  const terms = mentionTerms(forms, [
    {
      path: "src/features/forms/FormElement.ts",
      text: "export class FormElement extends HTMLElement {}\nexport const LOCALE_FIELD_NAME = '_locale';\nexport function submit() {}",
    },
    { path: "src/features/turnstile/constants.ts", text: "const a = 1;\nexport { a as TURNSTILE_TOKEN_FIELD, b };" },
    { path: "src/pages/api/contact-form.ts", text: "export const POST = () => {};" },
  ]);

  assert.ok(terms.includes("FormElement"));
  assert.ok(terms.includes("LOCALE_FIELD_NAME"));
  assert.ok(terms.includes("TURNSTILE_TOKEN_FIELD"));
  assert.ok(terms.includes("/api/contact-form"));
  assert.ok(!terms.includes("submit"));
  assert.ok(!terms.includes("POST"));
  assert.ok(!terms.includes("constants"));
});

test("mentionTerms names a field the feature stored on a document it does not own", () => {
  const contactForm = findFeature("contact-form");

  assert.ok(contactForm);
  assert.ok(mentionTerms(contactForm).includes("contactFormNotificationEmails"));
});

test("mentionTerms quotes a field named with a plain word, so prose about translations is not all reported", () => {
  const aiTranslation = findFeature("ai-translation");

  assert.ok(aiTranslation);

  const terms = mentionTerms(aiTranslation);

  assert.ok(terms.includes("`translations`"));
  assert.ok(!terms.includes("translations"));
  assert.ok(terms.includes("aiTranslation"));
});

test("exportedNames reads inline declarations and export lists, renames included", () => {
  assert.deepEqual(
    exportedNames("export type Props = {};\nexport default function A() {}\nexport { x as renamed, type Y, default as Z };"),
    ["Props", "A", "renamed", "Y", "Z"]
  );
});

test("apiRouteOf maps an endpoint file to the URL it serves, and nothing else to a route", () => {
  assert.equal(apiRouteOf("src/pages/api/contact-form.ts"), "/api/contact-form");
  assert.equal(apiRouteOf("src/pages/api/agents/llms-txt.ts"), "/api/agents/llms-txt");
  assert.equal(apiRouteOf("src/features/forms/index.ts"), undefined);
});

test("findMentions reports each matching line once, and formatMentions groups them by file", () => {
  const files = [
    { path: "docs/a.md", text: "intro\nThe contact form posts here.\nThe Contact Form, again, and RESEND_API_KEY" },
    { path: "docs/b.md", text: "nothing to see" },
  ];
  const mentions = findMentions(files, ["contact form", "RESEND_API_KEY"]);

  assert.deepEqual(
    mentions.map((mention) => mention.line),
    [2, 3]
  );
  assert.deepEqual(formatMentions(mentions), ["docs/a.md:2,3"]);
});

test("findMentions skips a line about the trim itself, which names every feature it can remove", () => {
  const files = [
    {
      path: "README.md",
      text: "- `npm run trim` removes legal pages, contact form, ... See [`docs/features/trimming-features.md`](x).\n- Remove a contact form -> [Trimming](./features/trimming-features.md)\n- The contact form posts here.\n- **contact-form** (run `npm run trim` first)",
    },
  ];

  assert.deepEqual(
    findMentions(files, ["contact form", "contact-form"]).map((mention) => mention.line),
    [3, 4]
  );
});

const ROOT = new URL("../../", import.meta.url).pathname;

const NOT_SOURCE = new Set(["node_modules", ".git", ".astro", ".wrangler", "dist", "backups"]);

/** The repository's own files whose name passes `keep`, read as the closing report reads them. */
function repositoryFiles(keep: (name: string) => boolean): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (NOT_SOURCE.has(entry.name)) {
        continue;
      }

      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(path);
      } else if (keep(entry.name)) {
        found.push({ path: relative(ROOT, path), text: readFileSync(path, "utf8") });
      }
    }
  };

  walk(ROOT);

  return found;
}

test("a language trim reports only the sentences saying the starter is configured for it, never the language as an example", () => {
  const italian = findFeature("language:it");

  assert.ok(italian);

  const dictionary = italian.paths[0] ?? "";
  const deleted = existsSync(join(ROOT, dictionary))
    ? [{ path: dictionary, text: readFileSync(join(ROOT, dictionary), "utf8") }]
    : [];
  const terms = mentionTerms(italian, deleted);
  const prose = repositoryFiles((name) => name.endsWith(".md"));
  const lineOf = ({ file, line }: { file: string; line: number }) =>
    prose.find(({ path }) => path === file)?.text.split("\n")[line - 1] ?? "";

  for (const mention of findMentions(prose, terms)) {
    assert.match(lineOf(mention), /configured/, `${mention.file}:${mention.line} is not a configuration sentence`);
  }

  assert.deepEqual(
    findMentions(
      repositoryFiles((name) => /\.test\.(ts|tsx|mts)$/.test(name)),
      terms
    ),
    []
  );
});

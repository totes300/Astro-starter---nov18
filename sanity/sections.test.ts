import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { SANITY_PAGE_DOCUMENT_TYPE, SINGLETON_ROUTES } from "./constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "./i18n";
import {
  localizeDocumentPath,
  resolveSectionRequest,
  SECTION_DOCUMENT_TYPES,
  SECTION_SEGMENTS,
  SECTION_TYPES,
  SECTIONS,
  type SectionTypes,
  sectionOfType,
  sectionPath,
  sectionPathIssue,
  sectionSegment,
} from "./sections";
import { slugifyText } from "./slug";

// Route folders are found rather than named, because this file travels with `sanity/`.
const CANDIDATE_ROUTE_DIRS = ["src/pages", "app/(web)/[locale]", "app/(web)"];
const ROOT = path.join(import.meta.dirname, "..");

// Fixtures derive from the configuration, so the suite survives a project changing its locales or trimming its sections.
const secondary = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const renamed = SECTIONS.filter((key) => sectionSegment(secondary, key) !== key);
// Read as `SectionTypes` and `Record<string, string>` throughout, so the suite still typechecks once a trim leaves no section.
const typesOf = (section: string) => (SECTION_TYPES as Record<string, SectionTypes>)[section] as SectionTypes;
const nested = SECTIONS.flatMap((owner) => (typesOf(owner).nested ?? []).map((type) => ({ owner, type })));

describe("section segments", () => {
  it("serves every section from a route folder named after its key", () => {
    for (const key of SECTIONS) {
      const found = CANDIDATE_ROUTE_DIRS.some((dir) => existsSync(path.join(ROOT, dir, key)));

      assert.ok(found, `No "${key}" route folder. Looked in: ${CANDIDATE_ROUTE_DIRS.join(", ")}`);
    }
  });

  it("keeps every index singleton at its section's default path", () => {
    for (const key of SECTIONS) {
      const { index } = typesOf(key);

      if (index) {
        assert.equal(SINGLETON_ROUTES[index as keyof typeof SINGLETON_ROUTES], `/${key}`, key);
      }
    }
  });

  it("names every section with a URL-safe word", () => {
    for (const [key, words] of Object.entries<Record<string, string>>(SECTION_SEGMENTS)) {
      for (const candidate of [key, ...Object.values(words)]) {
        assert.equal(slugifyText(candidate), candidate, `"${candidate}" (${key}) is not a clean URL segment`);
      }
    }
  });

  // A shared word would make a request ambiguous: the middleware could not tell which section's folder serves it.
  it("gives each language one distinct word per section, never another section's default", () => {
    const languages = new Set(Object.values<Record<string, string>>(SECTION_SEGMENTS).flatMap((words) => Object.keys(words)));

    for (const language of languages) {
      const owners = new Map<string, string>();

      for (const [key, words] of Object.entries<Record<string, string>>(SECTION_SEGMENTS)) {
        const localized = words[language] ?? key;

        assert.equal(owners.get(localized) ?? key, key, `"${localized}" names two sections in ${language}`);
        owners.set(localized, key);
      }

      for (const [localized, owner] of owners) {
        assert.ok(
          !SECTIONS.includes(localized as never) || localized === owner,
          `"${localized}" in ${language} is another section's default`
        );
      }
    }
  });

  it("files each document type under one section at most", () => {
    assert.equal(new Set(SECTION_DOCUMENT_TYPES).size, SECTION_DOCUMENT_TYPES.length);

    for (const type of SECTION_DOCUMENT_TYPES) {
      assert.ok(sectionOfType(type), type);
    }

    assert.equal(sectionOfType(SANITY_PAGE_DOCUMENT_TYPE), undefined);
    assert.equal(sectionOfType(undefined), undefined);
  });
});

describe("in the default locale", { skip: SECTIONS.length === 0 }, () => {
  it("uses the key as the section word", () => {
    for (const key of SECTIONS) {
      assert.equal(sectionSegment(DEFAULT_LOCALE, key), key);
      assert.equal(sectionPath(DEFAULT_LOCALE, key, "/hello"), `/${key}/hello`);
    }
  });

  it("leaves paths and requests alone", () => {
    for (const key of SECTIONS) {
      const { index, item } = typesOf(key);

      assert.equal(localizeDocumentPath(item, DEFAULT_LOCALE, `/${key}/hello`), `/${key}/hello`);
      assert.equal(resolveSectionRequest(DEFAULT_LOCALE, `/${key}/hello`), null);

      if (index) {
        assert.equal(localizeDocumentPath(index, DEFAULT_LOCALE, "/anything"), `/${key}`);
      }
    }

    assert.equal(localizeDocumentPath(SANITY_PAGE_DOCUMENT_TYPE, DEFAULT_LOCALE, "/about"), "/about");
  });

  it("keeps items under their section and everything else out of it", () => {
    for (const key of SECTIONS) {
      const { index, item } = typesOf(key);

      assert.equal(sectionPathIssue(item, DEFAULT_LOCALE, `/${key}/hello`), undefined);
      assert.match(sectionPathIssue(item, DEFAULT_LOCALE, "/hello") ?? "", new RegExp(`/${key}/hello`));
      assert.ok(sectionPathIssue(SANITY_PAGE_DOCUMENT_TYPE, DEFAULT_LOCALE, `/${key}/hello`));

      if (index) {
        assert.equal(sectionPathIssue(index, DEFAULT_LOCALE, `/${key}`), undefined);
      }
    }

    assert.equal(sectionPathIssue(SANITY_PAGE_DOCUMENT_TYPE, DEFAULT_LOCALE, "/about"), undefined);
  });
});

describe("in another locale", { skip: !IS_I18N_ENABLED || SECTIONS.length === 0 }, () => {
  it("moves a document's path into the language and back", () => {
    for (const key of SECTIONS) {
      const { index, item } = typesOf(key);
      const word = sectionSegment(secondary, key);
      const localized = localizeDocumentPath(item, secondary, `/${key}/hello`);

      assert.equal(localized, `/${secondary}/${word}/hello`);
      assert.equal(localizeDocumentPath(item, DEFAULT_LOCALE, localized), `/${key}/hello`);

      if (index) {
        assert.equal(localizeDocumentPath(index, secondary, `/${key}`), `/${secondary}/${word}`);
      }
    }

    assert.equal(localizeDocumentPath(SANITY_PAGE_DOCUMENT_TYPE, secondary, "/about"), `/${secondary}/about`);
  });

  it("serves the language's word from the section's folder", () => {
    for (const key of SECTIONS) {
      const word = sectionSegment(secondary, key);
      const expected = word === key ? null : { rewrite: `/${key}/hello` };

      assert.deepEqual(resolveSectionRequest(secondary, `/${word}/hello`), expected);
    }

    assert.equal(resolveSectionRequest(secondary, "/about"), null);
  });

  it("keeps the language's items under its word and its pages off it", () => {
    for (const key of SECTIONS) {
      const { item } = typesOf(key);
      const word = sectionSegment(secondary, key);

      assert.equal(sectionPathIssue(item, secondary, `/${secondary}/${word}/hello`), undefined);
      assert.ok(sectionPathIssue(item, secondary, `/${secondary}/hello`));
      assert.ok(sectionPathIssue(SANITY_PAGE_DOCUMENT_TYPE, secondary, `/${secondary}/${word}/hello`));
      assert.ok(sectionPathIssue(SANITY_PAGE_DOCUMENT_TYPE, secondary, `/${secondary}/${key}`));
    }
  });
});

describe("in a language that renames a section", { skip: !IS_I18N_ENABLED || renamed.length === 0 }, () => {
  it("redirects the default word to the language's own", () => {
    for (const key of renamed) {
      assert.deepEqual(resolveSectionRequest(secondary, `/${key}/hello`), {
        redirect: `/${secondary}/${sectionSegment(secondary, key)}/hello`,
      });
    }
  });

  it("keeps items off the default word", () => {
    for (const key of renamed) {
      assert.ok(sectionPathIssue(typesOf(key).item, secondary, `/${secondary}/${key}/hello`));
    }
  });
});

describe("a type nested under a section", { skip: nested.length === 0 }, () => {
  it("belongs to its section and moves with the section word like an item", () => {
    for (const { owner, type } of nested) {
      const uri = `/${owner}/authors/hello`;

      assert.equal(sectionOfType(type), owner, type);
      assert.ok(SECTION_DOCUMENT_TYPES.includes(type), type);
      assert.equal(localizeDocumentPath(type, DEFAULT_LOCALE, uri), uri);

      for (const locale of LOCALE_IDS) {
        const localized = localizeDocumentPath(type, locale, uri);

        assert.equal(localized, sectionPath(locale, owner, "/authors/hello"), `${type} in ${locale}`);
        assert.equal(localizeDocumentPath(type, DEFAULT_LOCALE, localized), uri, `${type} back from ${locale}`);
        assert.equal(sectionPathIssue(type, locale, localized), undefined, `${type} in ${locale}`);
      }
    }
  });

  it("must sit under its section's word, with no path guessed for it", () => {
    for (const { owner, type } of nested) {
      assert.equal(sectionPathIssue(type, DEFAULT_LOCALE, "/authors/hello"), `Must sit under "/${owner}/".`);
    }
  });

  it("is served from its section's folder in every language", { skip: !IS_I18N_ENABLED }, () => {
    for (const { owner } of nested) {
      const word = sectionSegment(secondary, owner);
      const expected = word === owner ? null : { rewrite: `/${owner}/authors/hello` };

      assert.deepEqual(resolveSectionRequest(secondary, `/${word}/authors/hello`), expected);
    }
  });
});

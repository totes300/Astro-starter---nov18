import assert from "node:assert/strict";
import { before, test } from "node:test";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "../i18n";
import { SECTION_TYPES, SECTIONS, type SectionTypes, sectionPath } from "../sections";

// Media fields pull in Studio inputs that read the API version from `sanity/config.ts`, which requires
// its env on import. Placeholders only where the environment has no value; imported once they are set.
const PLACEHOLDER_ENV: Record<string, string> = {
  SANITY_STUDIO_PROJECT_ID: "test-project",
  SANITY_STUDIO_DATASET: "test",
  SANITY_STUDIO_SITE_URL: "https://example.com",
  SANITY_STUDIO_API_VERSION: "2099-01-31",
  SANITY_STUDIO_BASE_PATH: "/studio",
};

for (const [name, value] of Object.entries(PLACEHOLDER_ENV)) {
  process.env[name] ??= value;
}

let redirect: typeof import("./documents/redirect").redirect;
let mediaPreviewSelect: typeof import("./fields/create-media").mediaPreviewSelect;
let createUriField: typeof import("./fields/create-uri-field").createUriField;
let site: typeof import("./documents/site").site;
let page: typeof import("./documents/page").page;

// Typed as a string: with one locale `LOCALE_IDS` narrows to the default's literal.
const secondaryLocale: string | undefined = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE);

before(async () => {
  ({ redirect } = await import("./documents/redirect"));
  ({ mediaPreviewSelect } = await import("./fields/create-media"));
  ({ createUriField } = await import("./fields/create-uri-field"));
  ({ site } = await import("./documents/site"));
  ({ page } = await import("./documents/page"));
});

type CustomValidator = (value: unknown, context: { parent?: unknown }) => true | string;

/** Captures the callback a field's `validation` passes to `Rule.custom`, mocking the rule chain. */
function captureFieldValidator(fieldName: string): CustomValidator {
  const field = (redirect.fields as Array<{ name: string; validation?: unknown }>).find((f) => f.name === fieldName);
  assert.ok(field?.validation, `field ${fieldName} has no validation`);

  let captured: CustomValidator | undefined;
  const rule = {
    required() {
      return this;
    },
    // The first custom is the path rule; `to` adds a destination lookup after it, as a warning.
    custom(fn: CustomValidator) {
      captured ??= fn;
      return this;
    },
    warning() {
      return this;
    },
  };

  (field.validation as (rule: unknown) => unknown)(rule);
  assert.ok(captured, `field ${fieldName} never called Rule.custom`);
  return captured;
}

test("redirect: from/to require a leading slash and reject paths that name the same page", () => {
  const loops =
    'The "From" and "To" paths name the same page (letter case, an anchor, a query or a trailing "/" does not change it), so the redirect would loop.';

  for (const [fieldName, otherField] of [
    ["from", "to"],
    ["to", "from"],
  ] as const) {
    const validate = captureFieldValidator(fieldName);

    assert.equal(validate(undefined, {}), true, `${fieldName}: empty is left to required()`);
    assert.equal(validate("about", {}), 'Path must start with a "/" (e.g., "/about").');
    assert.equal(validate("/same", { parent: { [otherField]: "/same" } }), loops);
    assert.equal(validate("/same/", { parent: { [otherField]: "/same" } }), loops);
    assert.equal(validate("/old-page", { parent: { [otherField]: "/new-page" } }), true);
  }
});

test("mediaPreviewSelect: bare and prefixed select maps", () => {
  assert.deepEqual(mediaPreviewSelect(), {
    type: "type",
    image: "image",
    playbackId: "video.asset.playbackId",
    thumbTime: "video.asset.thumbTime",
    videoCoverUrl: "videoCover.asset.url",
  });

  assert.deepEqual(mediaPreviewSelect("appMedia"), {
    type: "appMedia.type",
    image: "appMedia.image",
    playbackId: "appMedia.video.asset.playbackId",
    thumbTime: "appMedia.video.asset.thumbTime",
    videoCoverUrl: "appMedia.videoCover.asset.url",
  });
});

type Level = "error" | "warning";

/** Runs every `Rule.custom` callback a `validation` registers, and lists the level of each one that fails. */
function failures(validation: unknown, value: unknown, context: object): Level[] {
  const custom: Array<{ validate: (value: unknown, context: object) => unknown; level: Level }> = [];
  const rule = {
    required: () => rule,
    custom(validate: (value: unknown, context: object) => unknown) {
      const entry = { validate, level: "error" as Level };
      custom.push(entry);

      return {
        ...rule,
        warning() {
          entry.level = "warning";
          return rule;
        },
      };
    },
  };

  (validation as (rule: unknown) => unknown)(rule);

  return custom.flatMap(({ validate, level }) => {
    const result = validate(value, context);

    // A rule that reads other documents answers a promise; those need a dataset and are not run here.
    return result === true || result instanceof Promise ? [] : [level];
  });
}

function fieldValidation(field: { fields?: unknown }, name: string): unknown {
  const nested = (field.fields as Array<{ name: string; validation?: unknown }>).find((entry) => entry.name === name);
  assert.ok(nested?.validation, `field ${name} has no validation`);

  return nested.validation;
}

test("uri: a path the Studio, the not-found page or the section preview holds is refused, sub-paths included", () => {
  const validation = createUriField({ source: "title" }).validation;
  const at = (uri: string) => failures(validation, { current: uri }, { document: { _id: "doc-1", _type: "page" } });

  for (const uri of ["/studio", "/studio/pricing", "/404", "/section-preview", "/section-preview/x"]) {
    assert.deepEqual(at(uri), ["error"], uri);
  }

  for (const uri of ["/studios", "/4040", "/section-previews", "/about"]) {
    assert.deepEqual(at(uri), [], uri);
  }
});

test("uri: a reserved path stays reserved under any locale prefix", () => {
  const validation = createUriField({ source: "title" }).validation;

  for (const locale of LOCALE_IDS) {
    const at = (uri: string) =>
      failures(validation, { current: uri }, { document: { _id: "doc-1", _type: "page", language: locale } });

    for (const uri of ["/studio", "/404", "/section-preview", "/section-preview/x"]) {
      assert.deepEqual(at(`/${locale}${uri}`), ["error"], `/${locale}${uri}`);
    }

    assert.deepEqual(at(withLocalePrefix(locale, "/section-previews")), [], withLocalePrefix(locale, "/section-previews"));
  }
});

test("uri: the article and author routes keep their paths, and serve an article or a person only there", () => {
  const validation = createUriField({ source: "title" }).validation;
  const at = (uri: string, _type = "page") => failures(validation, { current: uri }, { document: { _id: "doc-1", _type } });

  // The blog section owns every path under its word, so a page cannot sit deeper under it either.
  for (const uri of [
    "/blog/foo",
    "/blog/authors",
    "/blog/authors/jane",
    "/blog/authors/jane/modal",
    "/blog/foo/bar",
    "/blog/authors/jane/cv",
    "/blog/authors/jane/modal/x",
  ]) {
    assert.deepEqual(at(uri), ["error"], uri);
  }

  assert.deepEqual(at("/blogs/foo"), []);

  assert.deepEqual(at("/blog/launch", "article"), []);
  assert.deepEqual(at("/blog/authors/jane", "person"), []);

  for (const uri of ["/launch", "/blog/launch/extra", "/blog/authors/jane", "/studio/launch"]) {
    assert.deepEqual(at(uri, "article"), ["error"], uri);
  }

  for (const uri of ["/jane", "/blog/jane", "/blog/authors", "/blog/authors/jane/extra"]) {
    assert.deepEqual(at(uri, "person"), ["error"], uri);
  }
});

test("uri: in every language, the blog index, its articles and its people keep their routes", () => {
  const validation = createUriField({ source: "title" }).validation;
  const blogIndex = createUriField({ source: "title", fixedPath: "/blog" }).validation;

  for (const language of LOCALE_IDS) {
    const at = (uri: string, _type: string, check: unknown = validation) =>
      failures(check, { current: uri }, { document: { _id: "generated-id", _type, language } });
    const blog = sectionPath(language, "blog");

    assert.deepEqual(at(blog, "blog", blogIndex), [], blog);
    assert.deepEqual(at(`${blog}/news`, "blog", blogIndex), ["error"], `${blog}/news`);
    assert.deepEqual(at(withLocalePrefix(language, "/news"), "blog", blogIndex), ["error"], `${language} /news`);
    assert.deepEqual(at(blog, "page"), ["error"], `a page at ${blog}`);
    assert.deepEqual(at(`${blog}/launch`, "article"), [], `${blog}/launch`);
    assert.deepEqual(at(`${blog}/authors/jane`, "person"), [], `${blog}/authors/jane`);
    assert.deepEqual(at(`${blog}/authors/jane`, "article"), ["error"], `an article at ${blog}/authors/jane`);
    assert.deepEqual(at(`${blog}/authors/jane/modal`, "page"), ["error"], `a page at ${blog}/authors/jane/modal`);
  }
});

test("uri: a section's word, in any language, holds only that section's documents", () => {
  const validation = createUriField({ source: "title" }).validation;

  for (const section of SECTIONS) {
    // Widened, so this still compiles once a trim leaves no section and `Section` is `never`.
    const { index, item }: SectionTypes = SECTION_TYPES[section];

    for (const language of LOCALE_IDS) {
      const at = (uri: string, _type: string) =>
        failures(validation, { current: uri }, { document: { _id: "doc-1", _type, language } });
      const itemPath = sectionPath(language, section, "/launch");

      assert.deepEqual(at(itemPath, item), [], itemPath);
      assert.deepEqual(at(itemPath, "page"), ["error"], `a page at ${itemPath}`);

      if (index) {
        assert.deepEqual(at(sectionPath(language, section), index), [], sectionPath(language, section));
        assert.deepEqual(at(itemPath, index), ["error"], `the index at ${itemPath}`);
      }
    }
  }
});

test("uri: a section's item sits exactly one segment under its word", () => {
  const validation = createUriField({ source: "title" }).validation;

  for (const section of SECTIONS) {
    // Widened, so this still compiles once a trim leaves no section and `Section` is `never`.
    const { item }: SectionTypes = SECTION_TYPES[section];

    for (const language of LOCALE_IDS) {
      const at = (uri: string) => failures(validation, { current: uri }, { document: { _id: "doc-1", _type: item, language } });

      assert.deepEqual(at(sectionPath(language, section, "/launch")), [], section);

      for (const rest of ["/launch/day", "/launch/day/recap"]) {
        assert.deepEqual(at(sectionPath(language, section, rest)), ["error"], sectionPath(language, section, rest));
      }
    }
  }
});

test("uri: every language's homepage is fixed at its own home path", () => {
  const uri = (page.fields as Array<{ name: string; validation?: unknown }>).find((field) => field.name === "uri");
  const at = (current: string, document: object) => failures(uri?.validation, { current }, { document });

  assert.deepEqual(at("/", { _id: "homepage", _type: "page", uri: { current: "/" } }), []);
  assert.deepEqual(at("/about", { _id: "homepage", _type: "page", uri: { current: "/about" } }), ["error"]);
  assert.deepEqual(at("/about", { _id: "drafts.homepage", _type: "page", uri: { current: "/about" } }), ["error"]);

  for (const language of LOCALE_IDS) {
    const home = withLocalePrefix(language, "/");

    assert.deepEqual(at(home, { _id: "generated-id", _type: "page", language, uri: { current: home } }), [], home);
  }
});

type ReadOnly = (context: { document?: object; value?: unknown }) => boolean;

function readOnlyOf(field: unknown): ReadOnly {
  return (field as { readOnly: ReadOnly }).readOnly;
}

test("uri: a fixed path locks the field by what the document is, never by the URI being typed", () => {
  const pageUri = readOnlyOf((page.fields as Array<{ name: string }>).find((field) => field.name === "uri"));
  const locked = (document: object, current: string) =>
    pageUri({ document: { ...document, uri: { current } }, value: { current } });

  assert.equal(locked({ _id: "homepage", _type: "page" }, "/"), true);
  assert.equal(locked({ _id: "versions.spring.homepage", _type: "page" }, "/"), true);
  // Editable while wrong, so it can be put back.
  assert.equal(locked({ _id: "drafts.homepage", _type: "page" }, "/home"), false);

  for (const language of LOCALE_IDS) {
    const home = withLocalePrefix(language, "/");
    const fixed = readOnlyOf(createUriField({ source: "title", fixedPath: "/fixed" }));
    const at = (current: string) => fixed({ document: { _id: "generated-id", _type: "page", language }, value: { current } });

    // Typed on the way to any other path, and where a title-less page is generated: the field must stay editable.
    assert.equal(locked({ _id: "drafts.new-page", _type: "page", language }, home), false, home);
    assert.equal(at(withLocalePrefix(language, "/fixed")), true, language);
    assert.equal(at(withLocalePrefix(language, "/other")), false, language);
  }
});

type Slugify = (input: string, schemaType: unknown, context: { parent: object }) => string;

function slugifyOf(field: unknown): Slugify {
  return (field as { options: { slugify: Slugify } }).options.slugify;
}

test("uri: a generated URI is slugified into the document's language, section word included", () => {
  const plain = slugifyOf(createUriField({ source: "title" }));
  const home = slugifyOf(createUriField({ source: "title", fixedPath: "/" }));

  assert.equal(plain("About us", {}, { parent: { _type: "page" } }), "", "a document with no id yet");

  for (const language of LOCALE_IDS) {
    const parent = { _id: "drafts.doc-1", _type: "page", language };

    assert.equal(plain("Qualità del servizio", {}, { parent }), withLocalePrefix(language, "/qualita-del-servizio"));
    assert.equal(home("Anything", {}, { parent }), withLocalePrefix(language, "/"));

    for (const section of SECTIONS) {
      const { item }: SectionTypes = SECTION_TYPES[section];
      const inSection = slugifyOf(createUriField({ source: "title", slugify: ({ slug }) => `/${section}/${slug}` }));
      const document = { ...parent, _type: item };

      assert.equal(inSection("Launch Day", {}, { parent: document }), sectionPath(language, section, "/launch-day"));
    }
  }
});

test("uri: a language prefix must match the document's language", { skip: !IS_I18N_ENABLED }, () => {
  const validation = createUriField({ source: "title" }).validation;
  const at = (uri: string, language: string, _type = "page") =>
    failures(validation, { current: uri }, { document: { _id: "doc-1", _type, language } });
  const secondary = secondaryLocale ?? DEFAULT_LOCALE;

  assert.deepEqual(at(`/${secondary}/about`, secondary), []);
  assert.deepEqual(at("/about", secondary), ["error"]);
  assert.deepEqual(at(`/${secondary}/about`, DEFAULT_LOCALE), ["error"]);
  assert.deepEqual(at(`/${secondary}`, DEFAULT_LOCALE), ["error"]);
  // The default language's own prefix is redirected away, so a URI stored with it is never served.
  assert.deepEqual(at(`/${DEFAULT_LOCALE}/about`, DEFAULT_LOCALE), ["error"]);
  assert.deepEqual(at(`/${secondary}/blog/authors/jane`, DEFAULT_LOCALE, "person"), ["error"]);

  // Left to the language field's own warning: there is no prefix to agree with.
  for (const language of ["zz", ""]) {
    assert.deepEqual(at("/zz/about", language), [], JSON.stringify(language));
  }
});

test("uri: a malformed URI keeps its one format error, without a second gate message", () => {
  const validation = createUriField({ source: "title" }).validation;

  for (const uri of ["/About", "/about/", "about", "//about", "/about.html", "/a:b", "/a%20b", "/team\\private", "/_internal"]) {
    for (const passwordProtected of [false, true]) {
      const context = { document: { _id: "doc-1", _type: "page", passwordProtected } };

      assert.deepEqual(failures(validation, { current: uri }, context), ["error"], JSON.stringify(uri));
    }
  }
});

test("uri: a page the gate cannot cover is a warning, and an error under Password protect", () => {
  const validation = createUriField({ source: "title" }).validation;
  const at = (uri: string, passwordProtected = false) =>
    failures(validation, { current: uri }, { document: { _id: "doc-1", _type: "page", passwordProtected } });

  assert.deepEqual(at("/about"), []);

  for (const uri of ["/api", "/api/pricing", "/index", "/about "]) {
    assert.deepEqual(at(uri), ["warning"], JSON.stringify(uri));
    assert.deepEqual(at(uri, true), ["error"], JSON.stringify(uri));
  }
});

test("uri: the gate checks the path the router sees once the language prefix is stripped", { skip: !IS_I18N_ENABLED }, () => {
  const validation = createUriField({ source: "title" }).validation;
  const secondary = secondaryLocale ?? DEFAULT_LOCALE;
  const document = { _id: "doc-1", _type: "page", language: secondary, passwordProtected: true };

  for (const path of ["/api/pricing", "/index"]) {
    assert.deepEqual(failures(validation, { current: `/${secondary}${path}` }, { document }), ["error"], path);
  }
});

test("seo: the Site singleton's No Index says it marks every page, not that it hides pages from the lists", () => {
  const seo = (site.fields as Array<{ name: string; fields?: Array<{ name: string; description?: string }> }>).find(
    (field) => field.name === "seoMetadata"
  );
  const description = seo?.fields?.find((field) => field.name === "noIndex")?.description ?? "";

  assert.match(description, /every page/);
  assert.doesNotMatch(description, /Keep this page out/);
});

// A client that answers nothing, so the rules that read other documents stay quiet and only the field's own rules speak.
const quietContext = (document: object, parent: object = {}) => ({
  document,
  parent,
  getClient: () => ({ fetch: async () => undefined }),
});

const seoPage = { _id: "drafts.page-1", _type: "page", title: "About the studio" };

test("seo: a description is required unless the route falls back to another field, on the homepage, or under noindex", async () => {
  const { createSeoField } = await import("./fields/create-seo-field");
  const own = fieldValidation(createSeoField(), "description");
  const withFallback = fieldValidation(createSeoField({ descriptionFallback: "summary" }), "description");
  const summary = "A summary of this page, long enough to stand in for its description.";

  assert.deepEqual(failures(own, undefined, quietContext(seoPage)), ["error"]);
  assert.deepEqual(failures(withFallback, undefined, quietContext({ ...seoPage, summary })), []);
  assert.deepEqual(failures(own, undefined, quietContext(seoPage, { noIndex: true })), []);
  assert.deepEqual(failures(own, undefined, quietContext({ ...seoPage, _id: "drafts.homepage" })), []);
  assert.deepEqual(failures(own, "Too short.", quietContext(seoPage)), ["warning"]);
});

test("seo: the title length rule reads the page title the route shows while SEO Title is empty", async () => {
  const { createSeoField } = await import("./fields/create-seo-field");
  const title = fieldValidation(createSeoField(), "title");

  assert.deepEqual(failures(title, undefined, quietContext({ ...seoPage, title: "Tiny" })), ["warning"]);
  assert.deepEqual(failures(title, "A search title that fits", quietContext({ ...seoPage, title: "Tiny" })), []);
  assert.deepEqual(failures(title, undefined, quietContext({ ...seoPage, title: "Tiny" }, { noIndex: true })), []);
});

test("seo: turning No Index on warns, off says nothing", async () => {
  const { createSeoField } = await import("./fields/create-seo-field");
  const noIndex = fieldValidation(createSeoField(), "noIndex");

  assert.deepEqual(failures(noIndex, true, quietContext(seoPage)), ["warning"]);
  assert.deepEqual(failures(noIndex, false, quietContext(seoPage)), []);
});

test("site: contacts warn until one links to a profile outside the site", async () => {
  const { site } = await import("./documents/site");
  const contacts = fieldValidation(site, "contacts");

  assert.deepEqual(failures(contacts, [{ appLink: { type: "internal" } }], quietContext({ _type: "site" })), ["warning"]);
  assert.deepEqual(
    failures(
      contacts,
      [{ appLink: { type: "external", external: "https://www.linkedin.com/company/example" } }],
      quietContext({})
    ),
    []
  );
});

test("settings: a redirect chain is refused, single hops pass", async () => {
  const { siteSettings } = await import("./documents/site-settings");
  const redirects = fieldValidation(siteSettings, "redirects");

  assert.deepEqual(
    failures(
      redirects,
      [
        { from: "/a", to: "/b" },
        { from: "/b", to: "/c" },
      ],
      {}
    ),
    ["error"]
  );
  assert.deepEqual(
    failures(
      redirects,
      [
        { from: "/a", to: "/c" },
        { from: "/b", to: "/c" },
      ],
      {}
    ),
    []
  );
});

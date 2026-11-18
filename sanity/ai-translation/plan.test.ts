import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { I18N_DOCUMENT_TYPES } from "../constants";
import { IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "../i18n";
import { planTranslationRefresh, planTranslationStub } from "../translation-stub";
import { fingerprint } from "./fingerprint";
import { mergeTranslation } from "./merge";
import {
  copyRecord,
  estimateCredits,
  inBulk,
  isFilledNamesDraft,
  needsWork,
  type PlanDocument,
  type PlanGroup,
  pairKey,
  planTranslations,
  RUN_ORDER,
  requiresOverwrite,
  runStep,
  sameDocumentIn,
  TRANSLATION_STATUSES,
  type TranslationStatus,
  translationRecord,
  translationStatus,
} from "./plan";
import { TEST_DEFAULT_LOCALE, TEST_LOCALES } from "./test-fixtures";

// biome-ignore lint/suspicious/noExplicitAny: fixtures are rewritten deep in place.
type Mutable = PlanDocument & Record<string, any>;

function doc(
  _id: string,
  _type: string,
  language: string | undefined,
  title: string,
  extra: Record<string, unknown> = {}
): Mutable {
  return {
    _id,
    _type,
    ...(language ? { language } : {}),
    title,
    body: [{ _key: "p1", _type: "block", children: [{ _key: "s1", _type: "span", text: `${title} body` }] }],
    ...extra,
  };
}

/** A translation written by an AI run: its record holds the source as read and itself as written. */
function translated(source: Mutable, _id: string, language: string): Mutable {
  const written: Mutable = { ...structuredClone(source), _id, language, title: `${source.title} [${language}]` };

  written.aiTranslation = translationRecord({
    source,
    written,
    sourceLanguage: TEST_DEFAULT_LOCALE,
    translatedAt: "2026-10-19T00:00:00Z",
  });

  return written;
}

function group(_id: string, links: Record<string, string>): PlanGroup {
  return {
    _id,
    _rev: `${_id}-rev`,
    translations: Object.entries(links).map(([language, ref]) => ({
      _key: `${_id}-${language}`,
      language,
      value: { _type: "reference", _ref: ref },
    })),
  };
}

describe("translationStatus", () => {
  const source = doc("about", "page", "en", "About");

  it("reads not translated, a copy, a hand translation and an up-to-date AI translation", () => {
    assert.equal(translationStatus({ source }), "notTranslated");
    assert.equal(translationStatus({ source, target: { ...source, _id: "about-it", language: "it" } }), "copyOfEnglish");
    assert.equal(translationStatus({ source, target: { ...source, _id: "about-it", title: "Chi siamo" } }), "translatedByHand");
    assert.equal(translationStatus({ source, target: translated(source, "about-it", "it") }), "upToDate");
  });

  it("applies the precedence: edited, translated by hand, English changed, layout changed, copy", () => {
    const target = translated(source, "about-it", "it");
    const edited = { ...target, title: "Edited by hand" };
    const textChanged = { ...source, title: "About us" };
    const textAndLayoutChanged = { ...textChanged, showHeader: true };
    const layoutChanged = { ...source, showHeader: true };

    assert.equal(translationStatus({ source: textChanged, target: edited }), "editedByHand");
    assert.equal(translationStatus({ source: textAndLayoutChanged, target }), "englishChanged");
    assert.equal(translationStatus({ source: layoutChanged, target }), "layoutChanged");
  });

  it("reads a copy whose own settings changed as edited by hand, so no bulk run resets them", () => {
    const copy = { ...source, _id: "about-it", language: "it" };

    assert.equal(translationStatus({ source, target: { ...copy, passwordProtected: true } }), "editedByHand");
    assert.equal(translationStatus({ source, target: { ...copy, seoMetadata: { noIndex: true } } }), "editedByHand");
    assert.equal(translationStatus({ source, target: { ...copy, uri: { current: "/it/about" } } }), "copyOfEnglish");
  });

  it("reads a record without hashes as no record", () => {
    const target = { ...source, _id: "about-it", aiTranslation: { sourceId: "about" } };

    assert.equal(translationStatus({ source, target }), "copyOfEnglish");
  });

  // A copy made from the Translations menu on Sep 10 carries its stamp, itself as made; an editor saved it since.
  const stamped = (english: Mutable, id: string): Mutable => {
    const copy: Mutable = { ...structuredClone(english), _id: id, language: "it", _createdAt: "2026-09-10T09:00:00Z" };

    return {
      ...copy,
      _updatedAt: "2026-09-12T09:00:00Z",
      aiTranslation: copyRecord(copy, { sourceId: english._id, sourceLanguage: "en" }),
    };
  };
  const paragraphs = ["One line about us.", "What we do.", "Who we serve.", "Where we work.", "How to reach us."];
  const english = doc("about", "page", "en", "About", {
    body: paragraphs.map((text, index) => ({
      _key: `p${index}`,
      _type: "block",
      children: [{ _key: `s${index}`, _type: "span", text }],
    })),
  });
  // The English gets a typo fix on Oct 5, after the copy was made.
  const typoFixed = (source: Mutable): Mutable => ({
    ...structuredClone(source),
    title: "About us",
    _updatedAt: "2026-10-05T09:00:00Z",
  });

  it("keeps an untouched stamped copy a copy once the English is edited, and never counts a stale one as edited", () => {
    const copy = stamped(english, "drafts.about-it");
    const withSection = { ...typoFixed(english), sections: [{ _key: "faq", _type: "faqSection", heading: "Questions" }] };

    assert.equal(translationStatus({ source: typoFixed(english), target: copy }), "copyOfEnglish");
    assert.equal(translationStatus({ source: withSection, target: copy }), "copyOfEnglish", "the English added a section");
    assert.equal(translationStatus({ source: english, target: { ...copy, passwordProtected: true } }), "editedByHand");
  });

  it("reads a copy partly translated by hand as translated by hand, whatever the English did since", () => {
    const copy = stamped(english, "drafts.about-it");
    // The title and 2 of 5 paragraphs translated: about 40% of the words, the rest still English.
    const partly: Mutable = structuredClone(copy);

    partly.title = "Chi siamo";
    partly.body[0].children[0].text = "Una riga su di noi.";
    partly.body[1].children[0].text = "Cosa facciamo.";

    const unstamped: Mutable = { ...structuredClone(partly), aiTranslation: undefined };

    for (const target of [partly, unstamped]) {
      const status = translationStatus({ source: typoFixed(english), target });

      assert.equal(status, "translatedByHand");
      assert.equal(inBulk(status, "missing"), false);
      assert.equal(inBulk(status, "refresh"), false);
      assert.equal(requiresOverwrite(status), true, "the dialog asks before replacing it");
      assert.equal(needsWork(status), false, "the server refuses it unless the run asked to overwrite");
    }
  });

  it("reads a finished translation whose words half stay English as translated by hand", () => {
    const team = doc("team", "page", "en", "Team", {
      body: ["Ada Lovelace, Head of Content", "Grace Hopper, Lead Engineer", "Alan Turing, Head of Research"].map(
        (text, index) => ({ _key: `p${index}`, _type: "block", children: [{ _key: `s${index}`, _type: "span", text }] })
      ),
    });
    const translation: Mutable = stamped(team, "team-it");

    translation.title = "Il team";
    translation.body[0].children[0].text = "Ada Lovelace, Head of Content (responsabile)";

    assert.equal(translationStatus({ source: typoFixed(team), target: translation }), "translatedByHand");
  });

  it("reads an unstamped copy as a copy only while its text is the English's", () => {
    const copy: Mutable = { ...structuredClone(english), _id: "about-it", language: "it" };

    assert.equal(translationStatus({ source: english, target: copy }), "copyOfEnglish");
    assert.equal(translationStatus({ source: typoFixed(english), target: copy }), "translatedByHand");
  });

  it("reads a copy whose links were re-pointed by hand as edited, a link moved to a variant as untouched", () => {
    const site = doc("site", "site", "en", "Site", {
      header: [
        { _key: "l1", _type: "navLink", page: { _type: "reference", _ref: "about" } },
        { _key: "l2", _type: "navLink", page: { _type: "reference", _ref: "contact" } },
      ],
    });
    const copy: Mutable = stamped(site, "drafts.site-it");
    const sameDocument = sameDocumentIn([
      ["about", "about-it"],
      ["contact", "contact-it"],
    ]);
    const toVariant: Mutable = structuredClone(copy);
    const toItalianOnly: Mutable = structuredClone(copy);

    toVariant.header[0].page._ref = "about-it";
    toItalianOnly.header[1].page._ref = "offerte-it";

    assert.equal(translationStatus({ source: site, target: toVariant, sameDocument }), "copyOfEnglish");
    assert.equal(translationStatus({ source: site, target: toItalianOnly, sameDocument }), "editedByHand");
    assert.equal(
      translationStatus({ source: site, target: { ...toItalianOnly, aiTranslation: undefined }, sameDocument }),
      "editedByHand"
    );
  });

  it("keeps an untouched stamped copy a copy when the English adds or drops a link since, and sees the copy's own", () => {
    const site = doc("site", "site", "en", "Site", {
      header: [{ _key: "l1", _type: "navLink", page: { _type: "reference", _ref: "about" } }],
    });
    const copy: Mutable = stamped(site, "drafts.site-it");
    const sameDocument = sameDocumentIn([["about", "about-it"]]);
    const added: Mutable = structuredClone(site);
    const linkAdded: Mutable = structuredClone(copy);

    added.header.push({ _key: "l2", _type: "navLink", page: { _type: "reference", _ref: "contact" } });
    linkAdded.header.push({ _key: "l2", _type: "navLink", page: { _type: "reference", _ref: "offerte-it" } });

    assert.equal(translationStatus({ source: added, target: copy, sameDocument }), "copyOfEnglish", "the English added a link");
    assert.equal(translationStatus({ source: { ...site, header: [] }, target: copy, sameDocument }), "copyOfEnglish");
    assert.equal(translationStatus({ source: site, target: { ...copy, header: [] }, sameDocument }), "editedByHand");
    assert.equal(translationStatus({ source: site, target: linkAdded, sameDocument }), "editedByHand", "the copy added one");
  });
});

describe("the bulk policy and the server re-check", () => {
  const expectations: Record<TranslationStatus, [missing: boolean, refresh: boolean, work: boolean, overwrite: boolean]> = {
    editedByHand: [false, false, false, true],
    translatedByHand: [false, false, false, true],
    englishChanged: [false, true, true, false],
    layoutChanged: [false, false, false, false],
    copyOfEnglish: [true, true, true, false],
    notTranslated: [true, true, true, false],
    upToDate: [false, false, false, false],
  };

  for (const status of TRANSLATION_STATUSES) {
    it(`${status}`, () => {
      assert.deepEqual(
        [inBulk(status, "missing"), inBulk(status, "refresh"), needsWork(status), requiresOverwrite(status)],
        expectations[status]
      );
      assert.equal(needsWork(status, true), true, "overwrite always spends");
    });
  }
});

describe("runStep", () => {
  it("runs labels, people, articles, legal pages, pages, the blog index, the homepage, then the Site", () => {
    const shipped: readonly string[] = ["labels", "person", "article", "legalPage", "page", "blog", "homepage", "site"];

    assert.deepEqual(
      RUN_ORDER.filter((step) => shipped.includes(step)),
      shipped
    );
    assert.equal(runStep("page", "drafts.homepage"), "homepage");
    assert.equal(runStep("page", "about"), "page");
    assert.equal(runStep("product", "x"), "legalPage", "an unknown translated type runs just before the pages");
  });

  it("gives every translated type its own step, so none runs or is grouped as another", () => {
    for (const type of I18N_DOCUMENT_TYPES) {
      assert.equal(runStep(type, `${type}-x`), type, type);
    }
  });
});

describe("estimateCredits", () => {
  it("is one AI request per pair plus one per 50 labels", () => {
    assert.deepEqual(estimateCredits(0, 0), { pairs: 0, labels: 0, labelBatches: 0, credits: 0 });
    assert.equal(estimateCredits(3, 50).credits, 4);
    assert.equal(estimateCredits(3, 51).credits, 5);
  });
});

describe("planTranslations", () => {
  const ada = doc("ada", "person", "en", "Ada", { name: "Ada" });
  const model = doc("model", "article", "en", "Model content");
  const modelDraft = { ...model, _id: "drafts.model", title: "Model content, not pages" };
  const terms = doc("drafts.terms", "legalPage", "en", "Terms");
  const about = doc("about", "page", "en", "About");
  const homepage = doc("homepage", "page", "en", "Home");
  const homepageChanged = { ...homepage, title: "Welcome home" };
  const blog = doc("blog", "blog", "en", "Blog");
  const blogLayoutChanged = { ...blog, showHeader: true };
  const site = doc("site", "site", "en", "Site", { name: "Acme" });

  const documents: PlanDocument[] = [
    ada,
    translated(ada, "ada-it", "it"),
    model,
    modelDraft,
    { ...structuredClone(model), _id: "model-it", language: "it" },
    terms,
    about,
    { ...doc("about-it", "page", "it", "Chi siamo") },
    homepageChanged,
    translated(homepage, "homepage-it", "it"),
    translated(homepageChanged, "drafts.homepage-de", "de"),
    blogLayoutChanged,
    { ...translated(blog, "blog-it", "it"), _id: "drafts.blog-it", title: "Il blog, a mano" },
    translated(blog, "blog-it", "it"),
    translated(blog, "blog-de", "de"),
    site,
    doc("orphan-it", "page", "it", "Orfana"),
    doc("nolang", "page", undefined, "No language"),
    doc("versions.r1.about", "page", "en", "Release copy"),
  ];

  const groups: PlanGroup[] = [
    group("g-ada", { en: "ada", it: "ada-it" }),
    group("g-model", { en: "model", it: "model-it" }),
    group("g-about", { en: "about", it: "about-it", de: "about-de" }),
    group("g-home", { en: "homepage", it: "homepage-it", de: "homepage-de" }),
    group("g-blog", { en: "blog", it: "blog-it", de: "blog-de" }),
    group("drafts.g-ignored", { en: "site", it: "ada" }),
  ];

  const labelDocuments: PlanDocument[] = [
    { _id: "category-publishing", _type: "articleCategory", name: { en: "Publishing", it: "Pubblicazione" } },
    { _id: "category-modelling", _type: "articleCategory", name: { en: "Content modelling" } },
    { _id: "category-done", _type: "articleCategory", name: { en: "Done", it: "Fatto" } },
    { _id: "drafts.category-done", _type: "articleCategory", name: { en: "Done", it: "Fatto", de: "Erledigt" } },
    { _id: "category-empty", _type: "articleCategory", name: { en: "" } },
  ];

  // The category is pinned like the locales, so a trim that removes it leaves these labels in place.
  const localizedFields = { articleCategory: ["name"] };
  const base = { documents, groups, labelDocuments, localizedFields, locales: TEST_LOCALES, defaultLocale: TEST_DEFAULT_LOCALE };
  const statuses = (plan: ReturnType<typeof planTranslations>) =>
    Object.fromEntries(
      plan.rows.map((row) => [row.sourceId, row.targets.map(({ language, status }) => `${language}:${status}`)])
    );

  it("lists every source in run order with a status per language", () => {
    const plan = planTranslations(base);

    assert.deepEqual(
      plan.rows.map(({ sourceId, step }) => `${step}:${sourceId}`),
      ["person:ada", "article:model", "legalPage:terms", "page:about", "blog:blog", "homepage:homepage", "site:site"]
    );
    assert.deepEqual(statuses(plan), {
      ada: ["it:upToDate", "de:notTranslated"],
      model: ["it:copyOfEnglish", "de:notTranslated"],
      terms: ["it:notTranslated", "de:notTranslated"],
      about: ["it:translatedByHand", "de:notTranslated"],
      blog: ["it:editedByHand", "de:layoutChanged"],
      homepage: ["it:englishChanged", "de:upToDate"],
      site: ["it:notTranslated", "de:notTranslated"],
    });
  });

  it("skips a source never published, flags unpublished changes, and points at a link whose document is gone", () => {
    const plan = planTranslations(base);
    const row = (id: string) => plan.rows.find(({ sourceId }) => sourceId === id);

    assert.equal(row("terms")?.skipped, "notPublished");
    assert.equal(row("terms")?.version, undefined);
    assert.ok(row("terms")?.targets.every(({ bulk }) => !bulk));
    assert.equal(row("model")?.hasUnpublishedChanges, true);
    assert.equal(row("model")?.version, "published");
    assert.equal(row("about")?.hasUnpublishedChanges, false);
    assert.equal(row("about")?.targets[1]?.staleRowKey !== undefined, true);
    assert.equal(row("about")?.metadataId, "g-about");
    assert.equal(row("about")?.metadataRev, "g-about-rev");
    assert.equal(row("blog")?.targets[0]?.hasDraft, true);
    assert.deepEqual(plan.missingLanguage, ["nolang"]);
  });

  it("estimates exactly: the bulk pairs under the policy plus one call per 50 labels", () => {
    const missing = planTranslations(base);
    const refresh = planTranslations({ ...base, policy: "refresh" });

    assert.deepEqual(
      missing.labels.map(({ id, missing: languages }) => `${id}:${languages.join(",")}`),
      ["category-modelling:it,de", "category-publishing:de"]
    );
    assert.deepEqual(missing.estimate, { pairs: 6, labels: 2, labelBatches: 1, credits: 7 });
    assert.deepEqual(refresh.estimate, { pairs: 7, labels: 2, labelBatches: 1, credits: 8 });
    assert.deepEqual(missing.summary.it, {
      editedByHand: 1,
      translatedByHand: 1,
      englishChanged: 1,
      layoutChanged: 0,
      copyOfEnglish: 1,
      notTranslated: 1,
      upToDate: 1,
    });
  });

  it("plans only the languages asked for", () => {
    const plan = planTranslations({ ...base, languages: ["it"] });

    assert.ok(plan.rows.every(({ targets }) => targets.length === 1 && targets[0]?.language === "it"));
    assert.deepEqual(plan.estimate, { pairs: 2, labels: 1, labelBatches: 1, credits: 3 });
  });

  it("plans one document from any of its translations, and translates its unpublished changes when asked", () => {
    const fromTranslation = planTranslations({ ...base, documentId: "drafts.about-it" });
    const withDraft = planTranslations({ ...base, documentId: "model", useDraft: true });

    assert.deepEqual(
      fromTranslation.rows.map(({ sourceId }) => sourceId),
      ["about"]
    );
    assert.deepEqual(fromTranslation.labels, []);
    assert.equal(withDraft.rows[0]?.version, "draft");
    assert.equal(withDraft.rows[0]?.targets[0]?.status, "translatedByHand", "the copy matches the published text, not the draft");
  });

  const unlinkedPlan = () =>
    planTranslations({
      ...base,
      documents: [
        doc("homepage", "page", "en", "Home", { uri: { current: "/" } }),
        doc("site", "site", "en", "Site"),
        doc("home-it", "page", "it", "Casa", { uri: { current: "/it" } }),
        doc("drafts.site-de", "site", "de", "Seite"),
        doc("orphan-de", "page", "de", "Waise"),
      ],
      groups: [],
    });
  const cells = (plan: ReturnType<typeof planTranslations>, id: string) =>
    (plan.rows.find(({ sourceId }) => sourceId === id)?.targets ?? []).map(
      ({ language, unlinkedId, bulk }) => `${language}:${unlinkedId ?? "-"}:${bulk}`
    );

  it("never plans a second copy of a singleton in a language that has one unlinked", () => {
    assert.deepEqual(cells(unlinkedPlan(), "site"), ["it:-:true", "de:site-de:false"]);
  });

  // The homepage's path in a language comes from the configured prefixes, so this one runs on a configured language.
  it("never plans a second page at a fixed URI taken by an unlinked one", { skip: !IS_I18N_ENABLED }, () => {
    const secondary = LOCALE_IDS.find((id) => id !== TEST_DEFAULT_LOCALE) ?? TEST_DEFAULT_LOCALE;
    const plan = planTranslations({
      ...base,
      locales: [{ id: TEST_DEFAULT_LOCALE, title: "English" }, { id: secondary, title: secondary }, ...TEST_LOCALES.slice(2)],
      documents: [
        doc("homepage", "page", "en", "Home", { uri: { current: "/" } }),
        doc("home-secondary", "page", secondary, "Home", { uri: { current: withLocalePrefix(secondary, "/") } }),
      ],
      groups: [],
    });

    assert.deepEqual(cells(plan, "homepage"), [`${secondary}:home-secondary:false`, "de:-:true"]);
    assert.equal(plan.estimate.pairs, 1);
  });

  it("leaves out of every batch a name that fails the checks itself or was rejected before, and names plain strings", () => {
    const plan = planTranslations({
      ...base,
      documents: [],
      labelDocuments: [
        { _id: "category-long", _type: "articleCategory", name: { en: "x".repeat(81) } },
        { _id: "category-rejected", _type: "articleCategory", name: { en: "Rejected" } },
        { _id: "category-changed", _type: "articleCategory", name: { en: "Changed since" } },
        { _id: "category-plain", _type: "articleCategory", name: "Not migrated" },
      ],
      rejectedLabels: { "category-rejected": "Rejected", "category-changed": "Changed" },
    });

    assert.deepEqual(
      plan.labels.map(({ id, handFix }) => `${id}:${handFix ?? "-"}`),
      ["category-changed:-", "category-long:sourceFailsChecks", "category-rejected:rejectedBefore"]
    );
    assert.deepEqual(
      plan.labelBatches.flat().map(({ id }) => id),
      ["category-changed"]
    );
    assert.deepEqual(plan.estimate, { pairs: 0, labels: 1, labelBatches: 1, credits: 1 });
    assert.deepEqual(plan.plainLabels, ["category-plain"]);
  });

  it("splits labels into batches of 50", () => {
    const many: PlanDocument[] = Array.from({ length: 51 }, (_, index) => ({
      _id: `c${String(index).padStart(2, "0")}`,
      _type: "articleCategory",
      name: { en: `Name ${index}` },
    }));
    const plan = planTranslations({ ...base, documents: [], labelDocuments: many });

    assert.deepEqual(
      plan.labelBatches.map((batch) => batch.length),
      [50, 1]
    );
    assert.equal(plan.estimate.credits, 2);
  });
});

describe("planTranslations, what a whole-site run leaves out", () => {
  const about = doc("about", "page", "en", "About", { _updatedAt: "2026-10-05T09:00:00Z" });
  const base = { locales: TEST_LOCALES, defaultLocale: TEST_DEFAULT_LOCALE, languages: ["it"] };
  const linked = group("g-about", { en: "about", it: "about-it" });
  const cell = (plan: ReturnType<typeof planTranslations>) => plan.rows[0]?.targets[0];

  it("never picks a copy someone partly translated, though its English changed since", () => {
    const made: Mutable = { ...structuredClone(about), _id: "about-it", language: "it", _createdAt: "2026-09-10T09:00:00Z" };
    const partly: Mutable = {
      ...made,
      aiTranslation: copyRecord(made, { sourceId: "about", sourceLanguage: "en" }),
      title: "Chi siamo",
      _updatedAt: "2026-09-12T09:00:00Z",
    };
    const plan = planTranslations({ ...base, documents: [{ ...about, title: "About us" }, partly], groups: [linked] });

    assert.equal(cell(plan)?.status, "translatedByHand");
    assert.equal(cell(plan)?.bulk, false);
    assert.equal(plan.estimate.pairs, 0);
  });

  it("holds out a translation only a release holds, keeping its row, and a pair whose call timed out on this text", () => {
    const inRelease = planTranslations({
      ...base,
      documents: [about],
      groups: [linked],
      versions: [{ _id: "versions.r1.about-it", _type: "page", language: "it" }],
    });
    const timedOut = planTranslations({
      ...base,
      documents: [about],
      groups: [],
      timedOut: { [pairKey("about", "it")]: fingerprint(about).textHash },
    });
    const stale = planTranslations({ ...base, documents: [about], groups: [], timedOut: { [pairKey("about", "it")]: "other" } });

    assert.deepEqual(
      [cell(inRelease)?.hold, cell(inRelease)?.bulk, cell(inRelease)?.staleRowKey],
      ["inRelease", false, undefined]
    );
    assert.deepEqual([cell(timedOut)?.hold, cell(timedOut)?.bulk], ["timedOut", false]);
    assert.deepEqual([cell(stale)?.hold, cell(stale)?.bulk], [undefined, true]);
  });
});

describe("isFilledNamesDraft", () => {
  const published = { _id: "c", _type: "articleCategory", name: { _type: "localizedString", en: "Design" }, slug: "design" };
  const draft = (name: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...published,
    _id: "drafts.c",
    _rev: "r2",
    name: { _type: "localizedString", ...name },
    ...extra,
  });

  it("is a labels pass's draft only when it fills empty names and changes nothing else", () => {
    assert.equal(isFilledNamesDraft(draft({ en: "Design", it: "Progettazione" }), published, ["name"], "en"), true);
    assert.equal(isFilledNamesDraft(draft({ en: "Design" }), published, ["name"], "en"), false, "nothing filled");
    assert.equal(isFilledNamesDraft(draft({ en: "Designing", it: "Progettare" }), published, ["name"], "en"), false);
    assert.equal(isFilledNamesDraft(draft({ en: "Design", it: "X" }, { slug: "x" }), published, ["name"], "en"), false);
    assert.equal(
      isFilledNamesDraft(
        draft({ en: "Design", it: "Nuovo" }),
        { ...published, name: { en: "Design", it: "Vecchio" } },
        ["name"],
        "en"
      ),
      false,
      "a name that was there is never changed"
    );
  });

  it("reads nested fields and portable text arms: a person's in-place draft fills a bio and an SEO title, and only them", () => {
    const fields = ["role", "bio", "seoMetadata.title"];
    const bio = [{ _type: "block", _key: "b", children: [{ _type: "span", _key: "s", text: "Hi" }] }];
    const person = {
      _id: "p",
      _type: "person",
      name: "Ada",
      bio: { en: bio },
      seoMetadata: { noIndex: false, title: { en: "Ada" } },
    };
    const filled = {
      ...person,
      _id: "drafts.p",
      bio: { en: bio, it: bio },
      seoMetadata: { noIndex: false, title: { en: "Ada", it: "Ada" } },
    };

    assert.equal(isFilledNamesDraft(filled, person, fields, "en"), true);
    assert.equal(isFilledNamesDraft({ ...filled, name: "Grace" }, person, fields, "en"), false, "a shared field changed");
    assert.equal(
      isFilledNamesDraft({ ...filled, seoMetadata: { ...filled.seoMetadata, noIndex: true } }, person, fields, "en"),
      false,
      "the object holding a nested field changed beside it"
    );
  });
});

describe("an AI write, read back", () => {
  const source = doc("about", "page", "en", "About", {
    _rev: "r1",
    uri: { _type: "slug", current: "/about" },
    cta: { _type: "reference", _ref: "contact", _weak: true },
    self: { _type: "reference", _ref: "about", _weak: true },
  });
  const result = { ...structuredClone(source), title: "Chi siamo" };
  const groups = [
    {
      variants: [
        { id: "contact", language: "en" },
        { id: "contact-it", language: "it" },
      ],
    },
  ];

  function withRecord(written: Mutable): Mutable {
    return {
      ...written,
      aiTranslation: translationRecord({ source, written, sourceLanguage: "en", translatedAt: "2026-10-19T00:00:00Z" }),
    };
  }

  it("is up to date as created, once its URI and references moved, and after a refresh", () => {
    const merged = mergeTranslation(source, result).document;
    const stub = planTranslationStub({ source: merged, locale: "it", sourceLocale: "en", excludedFields: [], groups });
    const created = withRecord({ ...stub.document, uri: { _type: "slug", current: "/it/chi-siamo" } });

    created.cta = { ...created.cta, _ref: stub.patch["cta._ref"] ?? created.cta._ref };
    created.self = { ...created.self, _ref: stub.patch["self._ref"] ?? created.self._ref };

    assert.equal(translationStatus({ source, target: created }), "upToDate");
    assert.equal(translationStatus({ source, target: { ...created, _id: "published-id", _rev: "r2" } }), "upToDate");

    const refresh = planTranslationRefresh({
      translated: mergeTranslation(source, { ...result, title: "Chi siamo davvero" }).document,
      target: { draft: created },
      locale: "it",
      sourceLocale: "en",
      excludedFields: ["aiTranslation"],
      groups,
    });

    assert.equal(translationStatus({ source, target: withRecord(refresh.document) }), "upToDate");
    assert.deepEqual(Object.keys(refresh.set), ["title"]);
  });
});

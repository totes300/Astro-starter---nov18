import assert from "node:assert/strict";
import { test } from "node:test";
import { findFeature } from "./features";
import { languageCensus } from "./language-removal";
import {
  describeStranded,
  describeUsage,
  type FeatureRow,
  formatLanguages,
  formatSurvey,
  hasStranded,
  needsRecording,
  orderDatasets,
} from "./status";

function row(id: string, overrides: Partial<FeatureRow> = {}): FeatureRow {
  const feature = findFeature(id);

  assert.ok(feature);

  return { feature, status: "present", unresolved: [], importers: [], content: [], ...overrides };
}

test("orderDatasets puts production first and keeps the rest in listed order", () => {
  assert.deepEqual(orderDatasets(["development", "staging", "production"]), ["production", "development", "staging"]);
  assert.deepEqual(orderDatasets(["development"]), ["development"]);
  assert.deepEqual(orderDatasets([]), []);
});

test("describeUsage counts documents and section uses in every dataset, singular when one", () => {
  const blog = row("blog", {
    content: [
      { dataset: "production", count: 1 },
      { dataset: "development", count: 12 },
    ],
  });
  const media = row("section:media", { content: [{ dataset: "production", count: 3 }] });

  assert.equal(describeUsage(blog), "1 document in production · 12 documents in development");
  assert.equal(describeUsage(media), "3 uses in production");
});

test("describeUsage says a code-only feature holds no content, and names importers and drift", () => {
  const forms = row("forms", {
    content: [{ dataset: "production", count: 0 }],
    importers: [{ file: "routes/contact.ts", target: "forms" }],
  });

  assert.equal(describeUsage(forms), "code only · imported by 1 file outside it");
});

test("needsRecording asks only in a project, and only when something is unsettled", () => {
  const settled = {
    role: "project" as const,
    record: { starter: { repository: "x", cutFrom: "2026-09-01" }, features: {}, sections: [], documentTypes: [] },
    rows: [row("blog")],
    unaccountedSections: [],
    unaccountedTypes: [],
  };

  assert.equal(needsRecording(settled), false);
  assert.equal(needsRecording({ ...settled, record: { ...settled.record, starter: { repository: "x", cutFrom: null } } }), true);
  assert.equal(needsRecording({ ...settled, rows: [row("blog", { status: "absent" })] }), true);
  assert.equal(needsRecording({ ...settled, unaccountedSections: ["FaqSection"] }), true);
  assert.equal(needsRecording({ ...settled, role: "starter", unaccountedSections: ["FaqSection"] }), false);
});

test("hasStranded is true for documents, section uses or fields in any dataset", () => {
  assert.equal(hasStranded([]), false);
  assert.equal(hasStranded([{ dataset: "production", documents: [], sections: [], fields: [] }]), false);
  assert.equal(
    hasStranded([{ dataset: "production", documents: [], sections: [{ type: "mediaSectionField", uses: 3 }], fields: [] }]),
    true
  );
  assert.equal(
    hasStranded([
      {
        dataset: "production",
        documents: [],
        sections: [],
        fields: [{ documentType: "site", name: "announcement", documents: 1 }],
      },
    ]),
    true
  );
});

const CONTEXT = {
  defaultLocale: "en",
  active: ["en"],
  commented: ["fr"],
  i18nTypes: ["page"],
  localizedFields: { articleCategory: ["name"] },
};

const census = (documents: { _id: string; _type: string; [field: string]: unknown }[], assets = []) =>
  languageCensus(
    { documents, assets },
    { defaultLocale: "en", keep: ["en"], i18nTypes: CONTEXT.i18nTypes, localizedFields: CONTEXT.localizedFields }
  );

const STRANDED_FR = {
  dataset: "production",
  documents: [],
  sections: [],
  fields: [],
  languages: census([
    { _id: "about", _type: "page", language: "en" },
    { _id: "about-fr", _type: "page", language: "fr" },
    { _id: "drafts.about-fr", _type: "page", language: "fr" },
    { _id: "blank", _type: "page", language: "" },
  ]),
};

test("hasStranded and describeStranded count a language LOCALES does not serve", () => {
  assert.equal(hasStranded([STRANDED_FR]), true);
  assert.equal(describeStranded(STRANDED_FR), "fr 1 document (+1 draft)");
});

test("text left in an unserved language is still stranded once its documents are gone", () => {
  const textOnly = {
    ...STRANDED_FR,
    languages: census([{ _id: "cat", _type: "articleCategory", name: { en: "News", fr: "Actualités" } }]),
  };

  assert.equal(hasStranded([textOnly]), true);
  assert.equal(describeStranded(textOnly), "fr 0 documents, 1 shared field");
});

test("the Languages block shows the config, what is left in other languages and what no removal can take", () => {
  const lines = formatLanguages({
    i18n: { context: CONTEXT },
    languages: [{ dataset: "production", documents: [], assets: [], census: STRANDED_FR.languages }],
    stranded: [STRANDED_FR],
  }).join("\n");

  assert.match(lines, /Languages \(sanity\/i18n\.ts\)/);
  assert.match(lines, /en {2}default · 1 document in production/);
  assert.match(lines, /fr {2}commented out · 2 documents in production/);
  assert.match(lines, /Content in languages this site does not serve/);
  assert.match(lines, /production: fr 1 document \(\+1 draft\)/);
  assert.match(lines, /production: "" 1 document\. An empty language means the language is missing/);
});

test("the Languages block is left out before i18n, and says what it cannot read", () => {
  assert.deepEqual(formatLanguages({ i18n: {}, languages: [], stranded: [] }), []);
  assert.deepEqual(formatLanguages({ i18n: { problem: "LOCALES is computed." }, languages: [], stranded: [] }), [
    "",
    "   Languages: LOCALES is computed.",
  ]);
});

test("describeUsage counts a language feature's documents per dataset", () => {
  const italian = row("language:it", { content: [{ dataset: "production", count: 9 }] });

  assert.equal(describeUsage(italian), "9 documents in production");
});

test("--status shows a ported feature as here, with the day it was recorded and what it holds", () => {
  const ported = { state: "ported" as const, on: "2026-10-23" };
  const lines = formatSurvey({
    role: "project",
    record: { starter: { repository: "x", cutFrom: "2026-09-01" }, features: { blog: ported }, sections: [], documentTypes: [] },
    rows: [row("blog", { status: "ported", record: ported, content: [{ dataset: "production", count: 3 }] })],
    unaccountedSections: [],
    unaccountedTypes: [],
    conflicts: [],
    unmodelled: [],
    datasets: ["production"],
    totals: [],
    stranded: [],
    i18n: {},
    languages: [],
  }).join("\n");

  assert.match(lines, /📥 ported +blog +taken after the cut on 2026-10-23 · 3 documents in production/);
});

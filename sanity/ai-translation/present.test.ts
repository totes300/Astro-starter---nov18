import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TRANSLATION_STATUSES } from "./plan";
import {
  AI_USAGE_NOTE,
  aiRequestCount,
  askDeveloperToRun,
  describePath,
  describePaths,
  fieldTitlesOf,
  formatDay,
  formatDuration,
  formatTimeLeft,
  handFixText,
  heldText,
  humanizeFieldName,
  jobStatePresentation,
  joinWords,
  keptAsTheyAre,
  languageName,
  linksCopy,
  parsePatchPath,
  policyTitles,
  requestsMadeCopy,
  requestsTodayCopy,
  runProgressCopy,
  statusLine,
  statusText,
  translatableSummary,
  translatedAtById,
  UPDATE_LINKS_NOTE,
  unlinkedText,
  wordCountCopy,
} from "./present";
import { TRANSLATE_MESSAGES } from "./wire";

// Built from code points, so this file itself holds no en or em dash.
const DASHES = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

function block(key: string, text: string) {
  return { _key: key, _type: "block", style: "normal", markDefs: [], children: [{ _key: `${key}s`, _type: "span", text }] };
}

const page = {
  _id: "about",
  _type: "page",
  language: "en",
  title: "About this demo",
  uri: { _type: "slug", current: "/about" },
  agentMarkdown: { markdown: "# About" },
  seoMetadata: { title: "About us", description: "Who we are and what we do.", noIndex: false },
  sections: [
    { _key: "s1", _type: "headlineSection", headline: "Hello there", theme: "dark" },
    { _key: "s2", _type: "textSection", content: [block("b1", "One two three."), block("b2", "Four five.")] },
    { _key: "s3", _type: "mediaSection", media: { asset: { _ref: "image-abc" } } },
  ],
};

const AT = "2026-10-20T12:00:00Z";

describe("statusText", () => {
  it("states each status as a fact, with a hint only where the table has one", () => {
    const expected = {
      notTranslated: { text: "Not translated yet" },
      copyOfEnglish: { text: "Still in English", hint: "The page exists but holds the English text." },
      upToDate: { text: "Translated by AI on 20 Oct 2026" },
      englishChanged: { text: "Translated by AI on 20 Oct 2026", hint: "English updated since." },
      layoutChanged: { text: "Translated by AI on 20 Oct 2026", hint: "English updated since." },
      editedByHand: { text: "Edited since the AI translation" },
      translatedByHand: { text: "Written by hand" },
    };

    for (const status of TRANSLATION_STATUSES) {
      const words = statusText(status, { translatedAt: AT });

      assert.deepEqual(words, expected[status], status);
      assert.doesNotMatch(statusLine(words), DASHES, status);
    }
  });

  it("never judges a translation: no old label survives, the route's fixed copy included", () => {
    const lines = [...TRANSLATION_STATUSES.map((status) => statusLine(statusText(status))), ...Object.values(TRANSLATE_MESSAGES)];

    for (const old of ["up to date", "layout changed", "copy of english", "edited by hand", "translated by hand"]) {
      assert.ok(!lines.some((line) => line.toLowerCase().includes(old)), old);
    }
  });

  it("falls back to no date, and names another default language", () => {
    assert.deepEqual(statusText("upToDate"), { text: "Translated by AI" });
    assert.deepEqual(statusText("englishChanged", { translatedAt: "not a date" }), {
      text: "Translated by AI",
      hint: "English updated since.",
    });
    assert.deepEqual(statusText("copyOfEnglish", { source: "German" }), {
      text: "Still in German",
      hint: "The page exists but holds the German text.",
    });
    assert.equal(
      statusLine({ text: "Translated by AI", hint: "English updated since." }),
      "Translated by AI. English updated since."
    );
    assert.equal(statusLine({ text: "Written by hand" }), "Written by hand");
  });

  it("says why a target or a name is left for a person, in the source language's name", () => {
    assert.equal(
      statusLine(unlinkedText("German")),
      "Not linked. This language already has its own version, not linked as its translation. Link it with Translate with AI on the German page instead of translating."
    );
    assert.deepEqual(unlinkedText(), unlinkedText("English"));
    assert.deepEqual(heldText("inRelease", { text: "Not translated yet" }), {
      text: "In a release",
      hint: "Its translation exists only inside a release. Publish or discard that release version, then translate.",
    });
    assert.match(
      heldText("twoGroups", { text: "Still in English", hint: "The page exists." }).hint ?? "",
      /^The page exists\. This/
    );
    assert.deepEqual(handFixText("sourceFailsChecks", "German"), {
      text: "Fill in by hand",
      hint: "The German name is too long or holds markup, so it is never sent to the AI.",
    });
    assert.match(handFixText("rejectedBefore").hint ?? "", /until the English name changes\.$/);

    for (const words of [unlinkedText(), handFixText("sourceFailsChecks"), handFixText("rejectedBefore")]) {
      assert.doesNotMatch(statusLine(words), DASHES);
    }
  });

  it("formats a day the way the rows show it", () => {
    assert.equal(formatDay(AT), "20 Oct 2026");
    assert.equal(formatDay("2026-09-20T12:00:00Z"), "20 Sep 2026", "three letters every month");
    assert.equal(formatDay(undefined), undefined);
    assert.equal(formatDay("soon"), undefined);
  });

  it("reads each translation's date from the draft first, as the plan reads its status", () => {
    assert.deepEqual(
      translatedAtById([
        { _id: "about-it", at: "2026-10-01T00:00:00Z" },
        { _id: "drafts.about-it", at: AT },
        { _id: "drafts.home-it", at: "2026-09-01T00:00:00Z" },
        { _id: "home-it", at: "2026-08-01T00:00:00Z" },
        { _id: "about-de" },
      ]),
      { "about-it": AT, "home-it": "2026-09-01T00:00:00Z" }
    );
  });

  it("names a language in English prose, and the policy options in the panel's words", () => {
    assert.equal(languageName("it"), "Italian");
    assert.equal(languageName("en"), "English");
    assert.equal(languageName("zz-unknown"), "zz-unknown");
    assert.deepEqual(policyTitles("English"), {
      missing: "Only pages not translated yet",
      refresh: "Also refresh AI translations whose English was updated",
    });
  });

  it("gives every run state a label and a tone", () => {
    assert.deepEqual(jobStatePresentation("failed"), { label: "Failed", tone: "critical" });
    assert.deepEqual(jobStatePresentation("saved_result"), { label: "Saved, not applied", tone: "caution" });
    assert.equal(jobStatePresentation("stopped").label, "Not started");
  });
});

describe("AI request copy", () => {
  it("counts the app's own AI requests with the right singular, and never names a price", () => {
    assert.equal(aiRequestCount(1), "1 AI request");
    assert.equal(aiRequestCount(8), "8 AI requests");
    assert.equal(aiRequestCount(1200), "1,200 AI requests");
    assert.equal(AI_USAGE_NOTE, "Uses your Sanity organization's AI credits. Check usage in your organization settings.");
    assert.doesNotMatch(AI_USAGE_NOTE, /[$€£]|\d/);
    assert.equal(requestsTodayCopy({ used: 3, max: 100 }), "AI requests today: 3 of 100");
  });

  it("counts requests that may still count in the progress line, as the done view and the panel do", () => {
    const totals = { finished: 12, total: 40, creditsSpent: 12, creditsMaybeSpent: 2 };

    assert.equal(runProgressCopy(totals), "12 of 40 done, 12 AI requests made, 2 more may still count");
    assert.equal(runProgressCopy({ ...totals, creditsMaybeSpent: 0 }), "12 of 40 done, 12 AI requests made");
    assert.equal(requestsMadeCopy({ creditsSpent: 0, creditsMaybeSpent: 0 }), "no AI requests made");
    assert.equal(requestsMadeCopy({ creditsSpent: 0, creditsMaybeSpent: 1 }), "0 AI requests made, 1 more may still count");
  });
});

describe("Update links", () => {
  it("sums a pass up, and says it publishes", () => {
    assert.equal(
      linksCopy({ relinked: ["a", "b"], published: ["a"], conflicts: ["c"], failed: ["d"], remaining: 3 }),
      "2 translations now link to pages in their own language, 1 page published, 1 changed meanwhile and were left alone, 1 could not be saved, 3 still to do: update links again."
    );
    assert.equal(
      linksCopy({ relinked: ["a"], published: [], conflicts: [], remaining: 0 }, false),
      "1 translation now links to pages in its own language, saved as drafts: publish them to make the links live."
    );
    assert.equal(
      linksCopy({ relinked: [], published: [], conflicts: [], remaining: 0 }),
      "Every link already points at the right language."
    );
    assert.match(UPDATE_LINKS_NOTE, /^Free\. .*publishes the pages it changes/);
  });

  it("asks a developer to run every command, never the editor", () => {
    assert.equal(askDeveloperToRun("sanity:schema-deploy"), "Ask a developer to run npm run sanity:schema-deploy.");
  });
});

describe("durations", () => {
  it("formats a timer and a rough time left", () => {
    assert.equal(formatDuration(9_400), "0:09");
    assert.equal(formatDuration(72_000), "1:12");
    assert.equal(formatDuration(3_723_000), "1:02:03");
    assert.equal(formatDuration(-5), "0:00");
    assert.equal(formatTimeLeft(20_000), "less than a minute left");
    assert.equal(formatTimeLeft(125_000), "about 2 min left");
  });
});

describe("what the AI translates", () => {
  it("groups the guard's own leaves by top-level field, with schema titles and a word count", () => {
    const summary = translatableSummary(page, { sections: "Page sections", seoMetadata: "SEO" });

    assert.deepEqual(summary.fields, [
      { name: "title", title: "Title", texts: 1, words: 3 },
      { name: "seoMetadata", title: "SEO", texts: 2, words: 9 },
      { name: "sections", title: "Page sections", texts: 3, words: 7, items: 2 },
    ]);
    assert.equal(summary.texts, 6);
    assert.equal(summary.words, 19);
  });

  it("leaves out what is never sent: the language, the slug, agent Markdown, a person's name", () => {
    const person = { _id: "ada", _type: "person", name: "Ada Lovelace", role: "Engineer" };

    assert.deepEqual(
      translatableSummary(person).fields.map(({ name }) => name),
      ["role"]
    );
    assert.ok(!translatableSummary(page).fields.some(({ name }) => ["uri", "agentMarkdown", "language"].includes(name)));
  });

  it("reads field titles from a schema type's shape", () => {
    const schemaType = {
      fields: [
        { name: "seoMetadata", type: { title: "SEO" } },
        { name: "title", type: {} },
      ],
    };

    assert.deepEqual(fieldTitlesOf(schemaType), { seoMetadata: "SEO" });
    assert.deepEqual(fieldTitlesOf(undefined), {});
    assert.equal(humanizeFieldName("seoMetadata"), "Seo metadata");
    assert.equal(humanizeFieldName("page_builder"), "Page builder");
  });

  it("rounds a word count the way the modal shows it", () => {
    assert.equal(wordCountCopy(0), "No text to translate");
    assert.equal(wordCountCopy(1), "1 word");
    assert.equal(wordCountCopy(537), "about 540 words");
  });

  it("names what is kept and what is not copied", () => {
    const { kept, notCopied } = keptAsTheyAre();

    assert.ok(
      kept.includes("an existing translation's URL and its Password protect and No Index switches"),
      "a new translation's slug is a choice, not kept"
    );
    assert.deepEqual(notCopied, ["agent Markdown"]);
    assert.equal(joinWords(["a", "b", "c"]), "a, b and c");
    assert.equal(joinWords(["a"]), "a");
    assert.equal(joinWords([]), "");
  });
});

describe("paths in plain words", () => {
  it("reads back the route's patch paths", () => {
    assert.deepEqual(parsePatchPath('sections[_key=="s2"].content[_key=="b1"]'), [
      "sections",
      { _key: "s2" },
      "content",
      { _key: "b1" },
    ]);
    assert.deepEqual(parsePatchPath('items[3]["odd name"]'), ["items", 3, "odd name"]);
  });

  it("numbers items and paragraphs from the source, and drops spans and slug insides", () => {
    const titles = { sections: "Page sections" };

    assert.equal(describePath('sections[_key=="s1"].headline', page, titles), "Page sections, item 1, headline");
    assert.equal(
      describePath('sections[_key=="s2"].content[_key=="b2"]', page, titles),
      "Page sections, item 2, content, paragraph 2"
    );
    assert.equal(
      describePath('sections[_key=="s2"].content[_key=="b1"].children[_key=="b1s"]', page, titles),
      "Page sections, item 2, content, paragraph 1"
    );
    assert.equal(describePath("uri.current", page), "URL slug");
    assert.equal(describePath('content[_key=="b"].markDefs[_key=="m"].href'), "Content, an item, link, an item, link");
    assert.equal(describePath('sections[_key=="gone"].headline'), "Sections, an item, headline");
  });

  it("de-duplicates and caps a long list", () => {
    const paths = Array.from({ length: 14 }, (_, index) => `field${index}`);

    assert.deepEqual(describePaths(["title", "title"], page), ["Title"]);
    assert.equal(describePaths(paths, page, undefined, 10).at(-1), "and 4 more");
  });
});

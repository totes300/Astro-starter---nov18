import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AI_TRANSLATION_STYLE_GUIDE_LIMIT } from "../constants";
import { getStudioLocaleTitle } from "../i18n";
import { SECTION_TYPES, SECTIONS, type SectionTypes } from "../sections";
import {
  ACTION_LABEL,
  acknowledgeTarget,
  applyAnswer,
  applyWarning,
  canRetryPlan,
  canStart,
  categoryJobs,
  categoryNames,
  categoryNote,
  coveredJobs,
  dialogSubject,
  dialogView,
  discardAnswer,
  documentProgress,
  documentRun,
  hasOwnSlug,
  initialPicks,
  instructionsLeft,
  instructionsRoom,
  isBlocked,
  isTranslateSwitchedOff,
  jobLine,
  labelsOutcome,
  linkAnswer,
  linkConfirmCopy,
  nextStep,
  noticeActionFor,
  otherJobHeading,
  pairOutcome,
  replaceWarning,
  requestTotalCopy,
  retryJobs,
  retryLabel,
  runAnnouncement,
  runningNote,
  runOutcome,
  runPicks,
  type StartCheck,
  selectTarget,
  startLabel,
  startNotices,
  stopLabel,
  summaryLine,
  type TargetOption,
  targetOptions,
  toastStatus,
  translateActionState,
  translationNote,
  unacknowledgedTargets,
  unavailableCopy,
  updateLinksToast,
} from "./dialog-model";
import type { PlanRow, PlanTarget, RunStep, TranslationPlan, TranslationStatus } from "./plan";
import { DRAFT_HINT, PUBLISH_ACCESS_TEXT, unlinkedText } from "./present";
import type { JobState, LabelsJob, PairJob, RelinkJob, RunJob, TranslationRun } from "./run-store";
import { RUN_INSTRUCTIONS_LIMIT } from "./style-guide";
import { type PairResult, type PlanResponse, TRANSLATE_MESSAGES } from "./wire";

// Built from code points, so this file itself holds no en or em dash.
const DASHES = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

function target(language: string, status: TranslationStatus, extra: Partial<PlanTarget> = {}): PlanTarget {
  return { language, status, hasDraft: false, bulk: false, ...extra };
}

function row(targets: PlanTarget[], extra: Partial<PlanRow> = {}): PlanRow {
  return {
    sourceId: "about",
    type: "page",
    title: "About this demo",
    uri: "/about",
    step: "page",
    version: "published",
    hasUnpublishedChanges: false,
    targets,
    ...extra,
  };
}

function plan(extra: Partial<TranslationPlan> = {}): Pick<PlanResponse, "plan"> {
  return {
    plan: {
      rows: [],
      labels: [],
      labelBatches: [],
      missingLanguage: [],
      summary: {},
      estimate: { pairs: 0, labels: 0, labelBatches: 0, credits: 0 },
      ...extra,
    },
  };
}

const SETTINGS: PlanResponse["settings"] = {
  defaults: {
    languages: [],
    policy: "missing",
    slugs: "translate",
    afterTranslate: "draft",
    maxCreditsPerRun: 25,
    maxCreditsPerDay: 100,
  },
  styleGuideLength: 0,
  styleGuideByLanguage: {},
  protectedPhrases: 0,
  glossaryTerms: 0,
  languageNotes: [],
};

function check(extra: Partial<StartCheck> = {}): StartCheck {
  return {
    response: {
      blocked: null,
      creditsToday: { day: "2026-10-20", used: 0, max: 100 },
      settings: SETTINGS,
    },
    credits: 1,
    otherRunActive: false,
    charactersLeft: 100,
    ...extra,
  };
}

function result(language: string, extra: Partial<PairResult> = {}): PairResult {
  return {
    status: "translated",
    sourceId: "about",
    language,
    creditSpent: true,
    durationMs: 9000,
    ...extra,
  };
}

function pair(language: string, state: JobState, extra: Partial<PairJob> = {}): PairJob {
  return {
    id: `run-1:${language}`,
    kind: "pair",
    step: "page",
    key: "source:about",
    title: "About this demo",
    state,
    attempts: 1,
    retries: { rateLimited: 0, busy: 0, outOfTime: 0 },
    creditSpent: false,
    creditMayBeSpent: false,
    input: { sourceId: "about", language, version: "published", overwrite: false, instructions: "" },
    sourceId: "about",
    language,
    ...extra,
  };
}

function labels(state: JobState, extra: Partial<LabelsJob> = {}): LabelsJob {
  return {
    id: "run-1:labels",
    kind: "labels",
    step: "labels",
    key: "labels",
    title: "Category name",
    state,
    attempts: 1,
    retries: { rateLimited: 0, busy: 0, outOfTime: 0 },
    creditSpent: false,
    creditMayBeSpent: false,
    input: { ids: ["category-content"], languages: ["it"] },
    ...extra,
  };
}

function links(state: JobState, extra: Partial<RelinkJob> = {}): RelinkJob {
  return {
    id: "run-1:relink",
    kind: "relink",
    step: "relink",
    key: "relink",
    title: "Update links",
    state,
    attempts: 1,
    retries: { rateLimited: 0, busy: 0, outOfTime: 0 },
    creditSpent: false,
    creditMayBeSpent: false,
    input: { publish: true },
    ...extra,
  };
}

function runOf(jobs: RunJob[], extra: Partial<TranslationRun> = {}): TranslationRun {
  return {
    id: "run-1",
    scope: { kind: "document", sourceId: "about" },
    publish: false,
    maxCredits: 25,
    status: "done",
    startedAt: 0,
    finishedAt: 20_000,
    jobs,
    ...extra,
  };
}

const optionsFor = (targets: PlanTarget[], defaultLanguages: string[] = []) =>
  targetOptions(row(targets), { source: "English", defaultLanguages, translatedAt: { "about-pl": "2026-10-20T12:00:00Z" } });

const option = (options: TargetOption[], language: string) =>
  options.find((entry) => entry.language === language) as TargetOption;

describe("translateActionState", () => {
  const base = {
    hasDocument: true,
    isVersion: false,
    isCategory: false,
    language: "en",
    defaultLocale: "en",
    progress: null,
  };

  it("is hidden on a release version and disabled until there is something to translate", () => {
    assert.equal(translateActionState({ ...base, isVersion: true }).hidden, true);
    assert.deepEqual(translateActionState({ ...base, hasDocument: false }), {
      hidden: false,
      disabled: true,
      label: ACTION_LABEL,
      title: "Save this document first: there is nothing to translate yet.",
    });
  });

  it("asks for a language first, but never on a category, which has none", () => {
    assert.equal(translateActionState({ ...base, language: undefined }).disabled, true);
    assert.match(translateActionState({ ...base, language: "" }).title ?? "", /sanity:migrate-backfill-language/);
    assert.equal(translateActionState({ ...base, isCategory: true, language: undefined }).disabled, false);
  });

  it("shows a run's progress and stays clickable, so the dialog can follow or stop it", () => {
    const state = translateActionState({ ...base, progress: { total: 2, finished: 1, active: true } });

    assert.equal(state.label, "Translating... 1 of 2");
    assert.equal(state.disabled, false);
  });

  it("opens on a translation, which explains that translations are made from the default language", () => {
    const state = translateActionState({ ...base, language: "it" });

    assert.equal(state.disabled, false);
    assert.equal(state.title, "Translations are made from the English page.");
    assert.deepEqual(translateActionState(base), { hidden: false, disabled: false, label: ACTION_LABEL });
  });

  it("is disabled for someone who cannot publish, saying why, before any plan is read", () => {
    assert.deepEqual(translateActionState({ ...base, canPublish: false }), {
      hidden: false,
      disabled: true,
      label: ACTION_LABEL,
      title: PUBLISH_ACCESS_TEXT,
    });
    assert.equal(translateActionState({ ...base, canPublish: true }).disabled, false);
    assert.equal(translateActionState({ ...base, canPublish: undefined }).disabled, false, "the route checks it anyway");
  });

  it("is hidden while Settings switch Translate with AI off, unless this tab's run is still going", () => {
    assert.equal(translateActionState({ ...base, isOff: true }).hidden, true);
    assert.equal(translateActionState({ ...base, isOff: true, progress: { total: 2, finished: 1, active: true } }).hidden, false);
    assert.equal(isTranslateSwitchedOff({ translations: { defaults: { maxCreditsPerDay: 0 } } }), true);
    assert.equal(isTranslateSwitchedOff({ translations: { defaults: { maxCreditsPerDay: 5 } } }), false);
    assert.equal(isTranslateSwitchedOff({ translations: { defaults: {} } }), false, "unset reads as the default limit");
    assert.equal(isTranslateSwitchedOff(null), false);
  });
});

describe("dialogSubject", () => {
  const source = row([target("it", "upToDate", { targetId: "about-it" })]);

  it("tells a source, one of its translations, a category, and a document with no source apart", () => {
    const response = plan({
      rows: [source],
      labels: [{ id: "cat", type: "articleCategory", field: "name", text: "Content", missing: ["it"] }],
    });

    assert.deepEqual(dialogSubject(response, "about", { isCategory: false }), { kind: "source", row: source });
    assert.deepEqual(dialogSubject(response, "about-it", { isCategory: false }), {
      kind: "translation",
      row: source,
      target: source.targets[0],
    });
    assert.equal(dialogSubject(response, "cat", { isCategory: true }).kind, "category");
    assert.deepEqual(dialogSubject(plan(), "cat", { isCategory: true }), { kind: "category", label: undefined });
    assert.deepEqual(dialogSubject(plan({ plainLabels: ["cat"] }), "cat", { isCategory: true }), {
      kind: "category",
      label: undefined,
      plain: true,
    });
    assert.equal(dialogSubject(response, "elsewhere", { isCategory: false }).kind, "unlinked");
    assert.equal(dialogSubject(plan({ missingLanguage: ["about"] }), "about", { isCategory: false }).kind, "missingLanguage");
  });
});

describe("targetOptions and picks", () => {
  const targets = [
    target("it", "notTranslated"),
    target("de", "copyOfEnglish", { targetId: "about-de" }),
    target("es", "englishChanged", { targetId: "about-es" }),
    target("nl", "editedByHand", { targetId: "about-nl" }),
    target("pt", "translatedByHand", { targetId: "about-pt" }),
    target("pl", "upToDate", { targetId: "about-pl", uri: "/pl/about" }),
    target("sv", "layoutChanged", { targetId: "about-sv" }),
  ];

  it("gives each row its text and hint, dated from the translation's record", () => {
    const options = optionsFor(targets);
    const words = Object.fromEntries(options.map(({ language, text, hint }) => [language, hint ? [text, hint] : [text]]));

    assert.deepEqual(words, {
      it: ["Not translated yet"],
      de: ["Still in English", "The page exists but holds the English text."],
      es: ["Translated by AI", "English updated since."],
      nl: ["Edited since the AI translation"],
      pt: ["Written by hand"],
      pl: ["Translated by AI on 20 Oct 2026"],
      sv: ["Translated by AI", "English updated since."],
    });
    assert.equal(option(options, "pl").uri, "/pl/about");
    assert.equal(option(options, "it").title, getStudioLocaleTitle("it"));
    assert.equal(option(options, "it").name, "Italian");
  });

  it("ticks only a missing page or one still in English, never one the AI or a person wrote", () => {
    const ticked = optionsFor(targets)
      .filter(({ preselected }) => preselected)
      .map(({ language }) => language);

    assert.deepEqual(ticked, ["it", "de"]);
  });

  it("ticks only Settings' default languages, unless none of them is offered", () => {
    assert.deepEqual(
      optionsFor(targets, ["de"])
        .filter(({ preselected }) => preselected)
        .map(({ language }) => language),
      ["de"]
    );
    assert.equal(optionsFor(targets, ["ja"]).filter(({ preselected }) => preselected).length, 2);
  });

  it("warns under every row whose page a run replaces, and asks to acknowledge hand changes", () => {
    const options = optionsFor(targets);
    const message =
      "Replaces the Dutch page with a fresh translation of the English. Changes and sections that exist only in Dutch are lost. Its URL, Password protect and No Index stay as they are.";

    assert.equal(option(options, "it").warning, undefined, "no page yet");
    assert.equal(option(options, "de").warning, undefined, "a copy of English loses nothing");
    assert.deepEqual(option(options, "nl").warning, {
      message,
      acknowledgement: "I understand the Dutch changes are replaced",
    });
    assert.equal(option(options, "pt").warning?.acknowledgement, "I understand the Portuguese changes are replaced");

    for (const language of ["es", "pl", "sv"]) {
      assert.match(option(options, language).warning?.message ?? "", /^Replaces the \w+ page with a fresh translation/);
      assert.equal(option(options, language).warning?.acknowledgement, undefined, language);
    }

    assert.deepEqual(replaceWarning("upToDate", "Italian", "English"), {
      message:
        "Replaces the Italian page with a fresh translation of the English. Changes and sections that exist only in Italian are lost. Its URL, Password protect and No Index stay as they are.",
    });
  });

  it("keeps Translate waiting until a ticked hand-written row is acknowledged, and sends it with overwrite", () => {
    const options = optionsFor(targets);
    const nl = option(options, "nl");
    let picks = selectTarget(initialPicks(options), nl, true);

    assert.deepEqual(
      unacknowledgedTargets(options, picks).map(({ language }) => language),
      ["nl"]
    );
    assert.equal(canStart({ credits: 3, unacknowledged: 1, notices: [] }), false);

    picks = acknowledgeTarget(picks, nl, true);

    assert.deepEqual(picks.nl, { selected: true, acknowledged: true });
    assert.deepEqual(unacknowledgedTargets(options, picks), []);
    assert.equal(canStart({ credits: 3, unacknowledged: 0, notices: [] }), true);
    assert.deepEqual(
      runPicks(options, picks).find(({ language }) => language === "nl"),
      { language: "nl", overwrite: true }
    );

    picks = selectTarget(picks, nl, true);

    assert.deepEqual(picks.nl, { selected: true, acknowledged: false }, "ticking again asks again");
    assert.deepEqual(selectTarget(picks, nl, false).nl, { selected: false, acknowledged: false });
  });

  it("acknowledges only a ticked row", () => {
    const options = optionsFor(targets);
    const picks = initialPicks(options);

    assert.equal(acknowledgeTarget(picks, option(options, "nl"), true), picks);
  });

  it("translates an AI page again with overwrite and no acknowledgement, and the rest as the server would", () => {
    const options = optionsFor(targets);
    const picks = selectTarget(selectTarget(initialPicks(options), option(options, "pl"), true), option(options, "es"), true);

    assert.deepEqual(runPicks(options, picks), [
      { language: "it", overwrite: false },
      { language: "de", overwrite: false },
      { language: "es", overwrite: false },
      { language: "pl", overwrite: true },
    ]);
    assert.deepEqual(unacknowledgedTargets(options, picks), []);
  });

  it("leaves a language with a saved result unticked, since applying it is free, and ticked anyway pays again", () => {
    const options = targetOptions(row(targets), { source: "English", saved: ["it", "pl"] });

    assert.equal(option(options, "it").preselected, false);
    assert.match(option(options, "it").hint ?? "", /A paid result is saved: apply it below for free/);
    assert.equal(option(options, "de").preselected, true);
    assert.doesNotMatch(option(options, "de").hint ?? "", /saved/);

    const picks = selectTarget(initialPicks(options), option(options, "it"), true);
    const sent = runPicks(options, picks);

    assert.deepEqual(
      sent.find(({ language }) => language === "it"),
      { language: "it", overwrite: true },
      "the route answers a saved result without overwrite"
    );
    assert.deepEqual(
      sent.find(({ language }) => language === "de"),
      { language: "de", overwrite: false }
    );
  });
});

const LINKED = { sourceId: "home", language: "it", targetId: "home-it", creditSpent: false } as const;

describe("held out of whole-site runs", () => {
  it("locks a translation only inside a release, which the route refuses", () => {
    const options = optionsFor([target("it", "notTranslated", { hold: "inRelease" })]);
    const italian = option(options, "it");

    assert.deepEqual([italian.text, italian.isLocked, italian.preselected], ["In a release", true, false]);
    assert.match(italian.hint ?? "", /only inside a release/);
    assert.deepEqual(runPicks(options, selectTarget(initialPicks(options), italian, true)), []);
  });

  it("offers a timed-out or doubly grouped page unticked, saying why a whole-site run leaves it out", () => {
    const options = optionsFor([
      target("it", "notTranslated", { hold: "timedOut" }),
      target("de", "copyOfEnglish", { hold: "twoGroups", targetId: "about-de" }),
    ]);

    for (const held of options) {
      assert.equal(held.preselected, false, held.language);
      assert.equal(held.isLocked, false, held.language);
      assert.match(held.hint ?? "", /whole-site runs leave it out/, held.language);
    }

    assert.match(option(options, "it").hint ?? "", /makes another AI request/);
    assert.equal(option(options, "it").text, "Not translated yet");
  });

  it("says when a translation is an AI draft nobody published", () => {
    const options = optionsFor([target("it", "upToDate", { targetId: "about-it", hasDraft: true, aiDraft: true })]);

    assert.match(option(options, "it").hint ?? "", new RegExp(`${DRAFT_HINT}$`));
  });
});

describe("a language that already has its own document there", () => {
  const targets: [PlanTarget, PlanTarget] = [
    target("it", "notTranslated", { unlinkedId: "home-it" }),
    target("de", "notTranslated"),
  ];

  it("is never ticked, cannot be sent, and says to link it instead", () => {
    const options = optionsFor([target("it", "notTranslated", { unlinkedId: "home-it", unlinkedTitle: "Home" }), targets[1]]);
    const italian = option(options, "it");

    assert.equal(italian.preselected, false);
    assert.equal(italian.unlinkedId, "home-it");
    assert.equal(italian.unlinkedTitle, "Home");
    assert.equal(italian.isLocked, true);
    assert.deepEqual([italian.text, italian.hint], [unlinkedText("English").text, unlinkedText("English").hint]);
    assert.doesNotMatch(italian.hint ?? "", /Translations menu/, "the plugin's menu cannot link an existing document");
    assert.equal(option(options, "de").preselected, true);

    const picks = selectTarget(initialPicks(options), italian, true);

    assert.deepEqual(runPicks(options, picks), [{ language: "de", overwrite: false }], "the route would refuse it");
  });

  it("asks to confirm the link with the document's own title, and warns that a person may be someone else", () => {
    assert.equal(
      linkConfirmCopy({ title: "Chi siamo", language: "it", sourceTitle: "About", step: "page" }),
      "Link “Chi siamo” as the Italian translation of “About”? It joins the translation group as it is: nothing is translated or published, and no AI request is made."
    );
    assert.match(
      linkConfirmCopy({ language: "it", sourceTitle: "Jane Doe", step: "person" }),
      /^Link this Italian document as .* change one of the slugs instead of linking\.$/
    );
    assert.deepEqual(linkAnswer({ ok: true, data: { ...LINKED, status: "preview", title: "Chi siamo" } }), {
      status: "preview",
      title: "Chi siamo",
    });
    assert.deepEqual(linkAnswer({ ok: true, data: { ...LINKED, status: "linked" } }), { status: "linked" });
    assert.deepEqual(
      linkAnswer({
        ok: false,
        error: {
          code: "link_taken",
          message: TRANSLATE_MESSAGES.link_taken,
          status: 409,
          creditSpent: false,
          creditMayBeSpent: false,
        },
      }),
      { status: "failed", message: TRANSLATE_MESSAGES.link_taken }
    );
  });

  it("offers no Apply on a result kept because that document appeared while the AI worked", () => {
    const kept = pair("it", "saved_result", { creditSpent: true, code: "unlinked_translation", message: "Link it." });

    assert.equal(pairOutcome(kept, "English").canApply, false);
    assert.equal(pairOutcome(kept, "English").message, "Link it.");
  });
});

describe("instructionsRoom", () => {
  it("leaves the server's cap when the style guide is short, and what the tightest language leaves otherwise", () => {
    assert.equal(instructionsRoom({}, ["it"]), RUN_INSTRUCTIONS_LIMIT);
    assert.equal(instructionsRoom({ it: 1500 }, ["it"]), AI_TRANSLATION_STYLE_GUIDE_LIMIT - 1500 - 2);
    assert.equal(instructionsRoom({ it: 1200, de: 1700 }, ["it", "de"]), AI_TRANSLATION_STYLE_GUIDE_LIMIT - 1700 - 2);
    assert.equal(instructionsRoom({ it: 2400 }, ["it"]), 0);
  });

  it("counts the instructions as the server does, trimmed", () => {
    assert.equal(instructionsLeft(10, "  abc  "), 7);
    assert.equal(instructionsLeft(2, "abcd"), -2);
  });
});

describe("startNotices", () => {
  const ids = (notices: ReturnType<typeof startNotices>) => notices.map(({ id }) => id);

  it("blocks a run on a drifted schema", () => {
    const drift = check({ response: { ...check().response, blocked: { code: "schema_drift", message: "" } } });

    assert.equal(startNotices(drift)[0]?.id, "schema_drift");
    assert.match(startNotices(drift)[0]?.message ?? "", /Ask a developer to run npm run sanity:schema-deploy/);
    assert.equal(isBlocked(startNotices(drift)), true);
  });

  it("blocks at today's limit, warns before it, and blocks over the run's limit", () => {
    const today = (used: number) => ({ ...check().response, creditsToday: { day: "2026-10-20", used, max: 100 } });

    assert.deepEqual(ids(startNotices(check({ response: today(100) }))), ["daily_cap"]);
    assert.deepEqual(
      startNotices(check({ response: today(99), credits: 2 })).map(({ id, blocking }) => [id, blocking]),
      [["daily_left", false]]
    );
    assert.match(startNotices(check({ credits: 26 }))[0]?.message ?? "", /over the limit of 25 per run/);
  });

  it("blocks on long instructions or another run, and shows nothing that does not apply", () => {
    const notices = startNotices(check({ credits: 0, charactersLeft: -3 }));

    assert.deepEqual(ids(notices), ["instructions"]);
    assert.match(notices[0]?.message ?? "", /3 characters too long/);
    assert.deepEqual(ids(startNotices(check({ otherRunActive: true, credits: 0 }))), ["busy"]);
    assert.deepEqual(startNotices(check({ credits: 0 })), [], "nothing ticked is the summary line's job");
    assert.deepEqual(startNotices(check()), []);
  });

  it("starts only with something ticked and nothing blocking", () => {
    assert.equal(canStart({ credits: 0, unacknowledged: 0, notices: [] }), false);
    assert.equal(canStart({ credits: 1, unacknowledged: 0, notices: startNotices(check({ otherRunActive: true })) }), false);
    assert.equal(canStart({ credits: 1, unacknowledged: 0, notices: startNotices(check({ credits: 1 })) }), true);
  });
});

describe("button, summary and footer copy", () => {
  it("names the languages on the button only when there is more than one", () => {
    assert.equal(startLabel(0), "Translate");
    assert.equal(startLabel(1), "Translate");
    assert.equal(startLabel(2), "Translate 2 languages");
    assert.equal(retryLabel(2), "Try again");
    assert.equal(stopLabel(1, false), "Stop after the 1 running");
    assert.equal(stopLabel(0, false), "Stop");
    assert.equal(stopLabel(1, true), "Stopping...");
    assert.equal(stopLabel(2, false, { site: true }), "Stop the site run after the 2 running");
    assert.equal(stopLabel(0, false, { site: true }), "Stop the site run");
  });

  it("sums up the words and the cost on one line, or asks for a tick", () => {
    assert.equal(summaryLine(127, 1), "About 130 words");
    assert.equal(summaryLine(127, 2), "About 130 words");
    assert.equal(summaryLine(7, 1), "7 words");
    assert.equal(summaryLine(127, 0), "Tick a language to translate.");
  });

  it("says why Translate waits while a replacement of hand changes is not acknowledged", () => {
    assert.equal(summaryLine(127, 2, [{ name: "Dutch" }]), 'Tick "I understand" for Dutch to translate.');
    assert.equal(
      summaryLine(127, 2, [{ name: "Dutch" }, { name: "Portuguese" }]),
      'Tick "I understand" for Dutch and Portuguese to translate.'
    );
  });

  it("says what a translation is, as a fact, on the translation itself", () => {
    assert.deepEqual(
      translationNote({
        language: "it",
        status: "englishChanged",
        sourceTitle: "About",
        source: "English",
        translatedAt: "2026-10-20T12:00:00Z",
      }),
      {
        heading: "This is the Italian translation of About.",
        status: "Translated by AI on 20 Oct 2026. English updated since.",
        note: "Translations are made from the English page.",
      }
    );
  });
});

describe("hasOwnSlug and categoryJobs", () => {
  it("offers the slug choice only where a translation gets its own path", () => {
    assert.deepEqual((["page", "article", "legalPage", "homepage", "blog", "person", "site"] as const).filter(hasOwnSlug), [
      "page",
      "article",
      "legalPage",
    ]);
  });

  it("offers it for every section's item, which takes its slug from its title, and never for a section's index", () => {
    for (const section of SECTIONS) {
      // Widened, so this still compiles once a trim leaves no section and `Section` is `never`.
      const { index, item }: SectionTypes = SECTION_TYPES[section];

      assert.equal(hasOwnSlug(item as RunStep), true, item);

      if (index) {
        assert.equal(hasOwnSlug(index as RunStep), false, index);
      }
    }
  });

  it("queues one label batch for a category's missing languages", () => {
    assert.deepEqual(categoryJobs("cat", { missing: ["it"] }, true), [
      { kind: "labels", title: "Category name", input: { ids: ["cat"], languages: ["it"], publish: true } },
    ]);
    assert.deepEqual(categoryJobs("cat", { missing: [] }, true), []);
    assert.deepEqual(categoryJobs("cat", undefined, true), []);
  });

  it("queues nothing for a name left for a hand fix, which the route would never send", () => {
    assert.deepEqual(categoryJobs("cat", { missing: ["it"], handFix: "rejectedBefore" }, true), []);
    assert.deepEqual(categoryJobs("cat", { missing: ["it"], handFix: "sourceFailsChecks" }, true), []);
  });

  it("says what a category run fills in, or that every name is there already", () => {
    assert.equal(
      categoryNote([{ missing: false }, { missing: true }]),
      "One AI request fills every name not translated yet. Names already set are never changed."
    );
    assert.equal(categoryNote([{ missing: false }]), "Every language has a name already, so there is nothing to translate.");
  });

  it("says why a category sends nothing: a name to fill in by hand, or one still plain text", () => {
    assert.equal(
      categoryNote([{ missing: true }], { handFix: "sourceFailsChecks", source: "English" }),
      "The English name is too long or holds markup, so it is never sent to the AI. Fill the names in by hand."
    );
    assert.equal(
      categoryNote([{ missing: true }], { handFix: "rejectedBefore", source: "English" }),
      "The AI's answer for it failed the checks, or left it out twice in a row, so it is not asked again until the English name changes. Fill the names in by hand."
    );
    assert.match(
      categoryNote([{ missing: true }], { plain: true }),
      /Ask a developer to run npm run sanity:migrate-localize-fields\.$/
    );
  });

  it("lists a category's names, with what a run fills in", () => {
    assert.deepEqual(categoryNames({ name: { en: "Content", it: " Contenuti " } }, "name", ["it", "de"], undefined), [
      { language: "it", title: getStudioLocaleTitle("it"), value: "Contenuti", missing: false },
      { language: "de", title: getStudioLocaleTitle("de"), missing: true },
    ]);
  });
});

describe("retryJobs", () => {
  it("tries again what failed or never started, never a stop code", () => {
    const jobs = [
      pair("it", "failed", { code: "timeout" }),
      pair("de", "failed", { code: "daily_cap" }),
      pair("fr", "stopped"),
      pair("es", "done"),
      labels("failed", { code: "server_error" }),
    ];
    const retried = retryJobs(runOf(jobs), jobs);

    assert.deepEqual(
      retried.map((job) => (job.kind === "pair" ? job.input.language : job.kind)),
      ["it", "fr", "labels"]
    );
    assert.deepEqual(retryJobs(runOf(jobs, { stopReason: { code: "budget_exceeded", message: "" } }), jobs), []);
  });

  it("leaves out a language that was applied, or whose paid result was saved after all", () => {
    const jobs = [pair("it", "failed", { code: "timeout" }), pair("de", "failed", { code: "timeout" }), pair("fr", "stopped")];

    assert.deepEqual(
      retryJobs(runOf(jobs), jobs, new Set(["run-1:it", "run-1:fr"])).map((job) => job.kind === "pair" && job.input.language),
      ["de"]
    );
  });

  it("updates links again after the languages it retries, or alone when only the links failed", () => {
    const failedPair = [pair("it", "failed", { code: "timeout" }), links("stopped")];

    assert.deepEqual(
      retryJobs(runOf(failedPair), failedPair).map(({ kind }) => kind),
      ["pair", "relink"]
    );

    const onlyLinks = [pair("it", "done"), links("failed", { code: "network" })];
    const retried = retryJobs(runOf(onlyLinks), onlyLinks);

    assert.deepEqual(retried, [{ kind: "relink", title: "Update links", input: { publish: true } }]);
    assert.equal(retryLabel(0), "Try again (free)");
    assert.equal(retryLabel(2), "Try again");

    const done = [pair("it", "done"), links("done")];

    assert.deepEqual(retryJobs(runOf(done), done), []);
  });

  it("drops Overwrite from a pair whose answer was lost, so a translation that landed is not paid for twice", () => {
    const overwrite = (language: string, extra: Partial<PairJob>) =>
      pair(language, "failed", { ...extra, input: { ...pair(language, "failed").input, overwrite: true } });
    const jobs = [
      overwrite("it", { code: "network", creditMayBeSpent: true }),
      overwrite("de", { code: "timeout", creditSpent: true, creditMayBeSpent: true }),
      overwrite("fr", { code: "invalid_request" }),
    ];
    const overwrites = retryJobs(runOf(jobs), jobs).map(
      (job) => job.kind === "pair" && [job.input.language, job.input.overwrite]
    );

    assert.deepEqual(overwrites, [
      ["it", false],
      ["de", true],
      ["fr", true],
    ]);
  });
});

describe("run views", () => {
  it("never puts the timer in the announcement, only what finished", () => {
    const running = runOf([pair("it", "done", { startedAt: 0, finishedAt: 9000 }), pair("de", "running", { startedAt: 9000 })], {
      status: "running",
      finishedAt: undefined,
    });
    const announcement = runAnnouncement(running);

    assert.equal(announcement, "1 of 2 done. Italian: Draft saved.");
    assert.doesNotMatch(announcement, /\d:\d\d/);
    assert.equal(jobLine(running.jobs[1] as RunJob, 21_000).elapsed, "0:12");
    assert.equal(runAnnouncement(null), "");
    assert.match(runAnnouncement({ ...running, status: "stopping" }), /Stopping after the running request\.$/);
  });

  it("names waits for a rate limit or a busy language", () => {
    assert.match(jobLine(pair("it", "queued", { retries: { rateLimited: 1, busy: 0, outOfTime: 0 } }), 0).label, /rate limiting/);
    assert.match(
      jobLine(pair("it", "queued", { retries: { rateLimited: 0, busy: 1, outOfTime: 0 } }), 0).label,
      /another request/
    );
    assert.equal(
      jobLine(pair("it", "queued", { retries: { rateLimited: 0, busy: 0, outOfTime: 1 } }), 0).label,
      "Waiting: asking again with a fresh request"
    );
  });

  it("sums a run up for the card and the toast", () => {
    const done = runOf([
      pair("it", "done", { creditSpent: true, result: result("it") }),
      pair("de", "done", { creditSpent: true, result: result("de") }),
    ]);

    assert.deepEqual(runOutcome(done), {
      tone: "positive",
      title: "Translated into Italian and German",
      description:
        "2 translated, 0 failed, 2 AI requests made. Once they are published, use Update links in Settings > Translations so other pages link to them.",
    });

    const published = (language: string) =>
      pair(language, "done", { creditSpent: true, result: result(language, { published: true }) });

    assert.equal(
      runOutcome(runOf([published("it"), links("done")])).description,
      "1 translated, 0 failed, 1 AI request made.",
      "the run updated the links itself"
    );
    assert.equal(
      runOutcome(runOf([published("it"), links("failed")])).description,
      "1 translated, 0 failed, 1 AI request made. Links were not updated: use Update links in Settings > Translations."
    );
    assert.equal(requestTotalCopy(done), "2 AI requests made");

    const mixed = runOf([pair("it", "failed", { creditMayBeSpent: true }), pair("de", "saved_result", { creditSpent: true })]);

    assert.equal(runOutcome(mixed).tone, "caution");
    assert.equal(
      runOutcome(mixed).description,
      "0 translated, 1 failed, 1 saved to apply for free, 1 AI request made, 1 more may still count."
    );

    const capped = runOf([pair("it", "stopped")], {
      stopReason: { code: "credit_cap", message: "Stopped at this run's limit." },
    });

    assert.equal(runOutcome(capped).tone, "critical");
    assert.match(runOutcome(capped).description, /^Stopped at this run's limit\. 0 translated/);
    assert.equal(requestTotalCopy(capped), "No AI requests made");
    assert.equal(requestTotalCopy(mixed), "1 AI request made, 1 more may still count");
    assert.equal(toastStatus("positive"), "success");
    assert.equal(toastStatus("caution"), "warning");
    assert.equal(toastStatus("critical"), "error");
  });

  it("says each language's outcome in one line, and offers Apply only on a saved result", () => {
    const published = pairOutcome(
      pair("it", "done", {
        creditSpent: true,
        startedAt: 0,
        finishedAt: 12_000,
        result: result("it", {
          published: true,
          targetId: "about-it",
          uri: "/it/chi-siamo",
          stats: { translated: 20, keptInEnglish: 6, guarded: 1, partial: true },
          keptPaths: ["a", "b", "c", "d", "e", "f"],
          guardedPaths: ['sections[_key=="s1"].theme'],
        }),
      }),
      "English"
    );

    assert.equal(published.line, `${getStudioLocaleTitle("it")}: translated and published`);
    assert.equal(published.keptNote, "6 texts came back in English, check them before publishing.");
    assert.equal(published.targetId, "about-it");
    assert.equal(published.canApply, false);
    assert.equal(
      pairOutcome(pair("it", "done", { result: result("it") }), "English").line,
      `${getStudioLocaleTitle("it")}: translated, saved as draft`
    );

    const clean = pairOutcome(
      pair("it", "done", { result: result("it", { stats: { translated: 9, keptInEnglish: 0, guarded: 2, partial: false } }) }),
      "English"
    );

    assert.equal(clean.keptNote, undefined, "no Details when nothing came back in English");

    const saved = pairOutcome(
      pair("it", "saved_result", { creditSpent: true, message: "Changed while translating." }),
      "English"
    );

    assert.equal(saved.canApply, true);
    assert.equal(saved.message, "Changed while translating.");
    assert.equal(saved.line, `${getStudioLocaleTitle("it")}: translated, not applied yet`);

    const lost = pair("it", "failed", { code: "timeout", creditMayBeSpent: true, message: "Timed out." });
    const recovered = pairOutcome(lost, "English", { saved: true });

    assert.equal(pairOutcome(lost, "English").canApply, false);
    assert.equal(pairOutcome(lost, "English").line, `${getStudioLocaleTitle("it")}: failed`);
    assert.equal(recovered.canApply, true);
    assert.equal(recovered.message, "The answer was lost, but the paid result was saved. Apply it for free.");
    assert.equal(pairOutcome(pair("it", "done"), "English", { saved: true }).canApply, false);
    assert.equal(pairOutcome(pair("it", "failed", { code: "budget_exceeded" }), "English").action, "openUsage");
    assert.equal(pairOutcome(pair("it", "stopped"), "English").line, `${getStudioLocaleTitle("it")}: not started`);
  });

  it("offers Open on every row that has a translation, a skipped one included", () => {
    const skipped = pair("it", "skipped", { result: result("it", { status: "skipped", targetId: "about-it" }) });

    assert.equal(pairOutcome(skipped, "English").targetId, "about-it");
    assert.equal(pairOutcome(pair("de", "failed"), "English").targetId, undefined);
  });

  it("lists a category run's names", () => {
    const job = labels("done", {
      result: {
        status: "translated",
        creditSpent: true,
        languages: ["it"],
        labels: { "category-content": { it: "Contenuti" } },
        written: ["category-content"],
        remaining: 0,
        durationMs: 1,
      },
    });

    assert.deepEqual(labelsOutcome(job, "category-content"), [
      { language: "it", title: getStudioLocaleTitle("it"), value: "Contenuti", missing: false },
    ]);
    assert.equal(jobLine(job, 0).label, "Category names saved");
  });

  it("says what comes next only after drafts: publish, then update links", () => {
    const draft = (language: string) => pair(language, "done", { result: result(language) });

    assert.equal(
      nextStep([draft("it")]),
      "Review the draft, then publish it. Then use Update links, so other pages link to it instead of the English page."
    );
    assert.equal(
      nextStep([draft("it"), draft("de")], "English"),
      "Review the drafts, then publish them. Then use Update links, so other pages link to them instead of the English pages."
    );
    assert.equal(nextStep([pair("it", "done", { result: result("it", { published: true }) })]), undefined);
    assert.equal(nextStep([pair("it", "failed")]), undefined);
  });

  it("names the Update links pass in the run and the done view", () => {
    const passed = links("done", { result: { relinked: ["home-it"], published: ["home-it"], conflicts: [], remaining: 0 } });

    assert.equal(jobLine(links("running"), 0).label, "Updating links on other pages");
    assert.deepEqual(
      [jobLine(passed, 0).label, jobLine(passed, 0).detail],
      ["Links updated", "1 translation now links to pages in its own language, 1 page published."]
    );
    assert.equal(otherJobHeading(passed), "Links updated");
    assert.equal(otherJobHeading(links("failed")), "Links not updated");
    assert.equal(otherJobHeading(links("stopped")), "Links not updated: the run stopped first");
    assert.equal(otherJobHeading(labels("done")), "Category names saved");
  });

  it("says the run lives in this tab, so closing the tab, not the dialog, ends it", () => {
    for (const note of [runningNote(false), runningNote(true)]) {
      assert.match(note, /You can close this dialog\. Keep this browser tab open until the run ends\./);
      assert.doesNotMatch(note, /close this window/);
    }

    assert.match(runningNote(true), /^This document is part of the whole-site run/);
  });

  it("sends the editor to Sanity Manage after a spent budget or a lasting rate limit, only on a failed row", () => {
    assert.equal(noticeActionFor("rate_limited"), "openUsage");
    assert.equal(noticeActionFor("budget_exceeded"), "openUsage");
    assert.equal(noticeActionFor("daily_cap"), "openSettings");
    assert.equal(pairOutcome(pair("it", "stopped", { code: "rate_limited" }), "English").action, undefined);
  });
});

describe("dialogView", () => {
  const state = { run: null, plan: "ready", hasPlan: true, subject: "source" } as const;

  it("shows a run first, then the plan's answer about this document", () => {
    assert.equal(dialogView({ ...state, run: "running", plan: "failed" }), "running");
    assert.equal(dialogView({ ...state, run: "done" }), "done");
    assert.equal(dialogView({ ...state, plan: "loading", hasPlan: false, subject: null }), "loading");
    assert.equal(dialogView({ ...state, plan: "loading" }), "configure", "the last plan stays while a new one loads");
    assert.equal(dialogView({ ...state, plan: "failed", hasPlan: false }), "failed");
    assert.equal(dialogView({ ...state, subject: "translation" }), "translation");
    assert.equal(dialogView({ ...state, subject: "unlinked" }), "unavailable");
    assert.equal(dialogView({ ...state, subject: "missingLanguage" }), "unavailable");
    assert.equal(dialogView({ ...state, subject: "category" }), "configure");
  });

  it("offers Try again on a failed plan only when asking again could help", () => {
    for (const code of ["forbidden", "unauthorized", "off", "i18n_disabled"]) {
      assert.equal(canRetryPlan(code), false, code);
    }

    for (const code of ["network", "timeout", "sanity_unavailable", "auth_unavailable", "schema_drift"]) {
      assert.equal(canRetryPlan(code), true, code);
    }
  });

  it("says why there is nothing to translate, with the right article and no menu that cannot link", () => {
    const unlinked = unavailableCopy("unlinked", "English");

    assert.match(unlinked, /^This document is not linked to an English page/);
    assert.doesNotMatch(unlinked, /a English|translations menu/);
    assert.match(unavailableCopy("none", "German"), /linked to a German page/);
    assert.equal(unavailableCopy("missingLanguage", "English"), TRANSLATE_MESSAGES.missing_language);
  });
});

describe("saved results", () => {
  const source = row([
    target("it", "editedByHand", { targetId: "about-it" }),
    target("de", "upToDate", { targetId: "about-de" }),
  ]);

  it("asks before Apply replaces changes made by hand since, and when the route says so", () => {
    assert.deepEqual(applyWarning(source, "it"), {
      message:
        "Applying replaces the Italian page with this saved translation. Changes made in Italian since are lost. Its URL, Password protect and No Index stay as they are.",
      acknowledgement: "I understand the Italian changes are replaced",
    });
    assert.equal(applyWarning(source, "de"), undefined);
    assert.equal(applyWarning(source, "de", { forced: true })?.acknowledgement, "I understand the German changes are replaced");
    assert.equal(applyWarning(undefined, "it"), undefined);
  });

  it("reads Apply and Discard answers into what the view does next", () => {
    const applied = applyAnswer({ ok: true, data: result("it", { published: true }) }, "Italian");
    const overwrite = applyAnswer(
      {
        ok: false,
        error: {
          code: "needs_overwrite",
          message: TRANSLATE_MESSAGES.needs_overwrite,
          status: 409,
          creditSpent: false,
          creditMayBeSpent: false,
        },
      },
      "Italian"
    );

    assert.deepEqual(applied, {
      outcome: "applied",
      toast: { status: "success", title: "Applied the Italian translation", description: "It is published." },
    });
    assert.equal(overwrite.outcome, "needsOverwrite");
    assert.equal(overwrite.toast.description, TRANSLATE_MESSAGES.needs_overwrite);
    assert.equal(
      applyAnswer({ ok: true, data: result("it", { status: "busy", message: "Busy." }) }, "Italian").outcome,
      "failed"
    );

    const discarded = discardAnswer(
      { ok: true, data: { status: "discarded", sourceId: "about", language: "it", creditSpent: false } },
      "Italian"
    );

    assert.equal(discarded.ok, true);
    assert.equal(discarded.toast.description, "Nothing offers the Italian result again.");
    assert.equal(
      discardAnswer(
        { ok: true, data: { status: "busy", code: "busy", sourceId: "about", language: "it", creditSpent: false } },
        "Italian"
      ).ok,
      false
    );
    assert.equal(
      updateLinksToast({ ok: true, data: { relinked: [], published: [], conflicts: [], remaining: 0 } }).description,
      "Every link already points at the right language."
    );
  });
});

describe("coveredJobs and documentProgress", () => {
  it("reads a document's own run whole, and its share of a whole-site run", () => {
    const own = runOf([pair("it", "done"), pair("de", "running")], { status: "running" });

    assert.equal(coveredJobs(own, "about").length, 2);
    assert.deepEqual(documentProgress(own, "about"), { total: 2, finished: 1, active: true });

    const linking = runOf([pair("it", "done"), links("running")], { status: "running" });

    assert.equal(coveredJobs(linking, "about").length, 2, "the done view shows Update links too");
    assert.deepEqual(documentProgress(linking, "about"), { total: 1, finished: 1, active: false }, "the label counts languages");

    const site = runOf([labels("done"), pair("it", "queued"), { ...pair("it", "queued"), id: "other", sourceId: "home" }], {
      scope: { kind: "site" },
      status: "running",
    });

    assert.equal(coveredJobs(site, "about").length, 1);
    assert.equal(coveredJobs(site, "category-content")[0]?.kind, "labels");
    assert.equal(documentProgress(site, "nowhere"), null);
    assert.equal(documentProgress(runOf([pair("it", "done")]), "about")?.active, false);
  });

  it("sums up a finished whole-site run for this document only, never the site's counts or credits", () => {
    const home = (state: JobState) => ({ ...pair("it", state), id: `home:${state}`, sourceId: "home", creditSpent: true });
    const about = { ...pair("it", "done", { result: result("it") }), creditSpent: true };
    const site = runOf([about, home("done"), home("failed")], { scope: { kind: "site" } });
    const own = runOf([about]);

    assert.equal(runOutcome(site).title, "Translation finished with problems");
    assert.equal(documentRun(own, "about"), own);
    assert.deepEqual(
      documentRun(site, "about")?.jobs.map(({ id }) => id),
      [about.id]
    );
    assert.deepEqual(runOutcome(documentRun(site, "about") as TranslationRun), {
      tone: "positive",
      title: "Translated into Italian",
      description:
        "1 translated, 0 failed, 1 AI request made. Once it is published, use Update links in Settings > Translations so other pages link to it.",
    });
    assert.equal(documentRun(site, "nowhere"), null);
    assert.equal(documentRun(null, "about"), null);
  });
});

describe("copy", () => {
  it("has no en or em dash anywhere", () => {
    const copy = [
      summaryLine(130, 2),
      summaryLine(130, 2, [{ name: "Dutch" }]),
      categoryNote([]),
      categoryNote([], { handFix: "rejectedBefore" }),
      categoryNote([], { handFix: "sourceFailsChecks" }),
      categoryNote([], { plain: true }),
      ...optionsFor([
        target("nl", "editedByHand", { targetId: "about-nl" }),
        target("pl", "upToDate"),
        target("it", "notTranslated", { unlinkedId: "x" }),
      ]).flatMap(({ text, hint, warning }) => [text, hint ?? "", warning?.message ?? "", warning?.acknowledgement ?? ""]),
      ...startNotices(check({ credits: 30, charactersLeft: -1, otherRunActive: true })).map(({ message }) => message),
      runningNote(true),
      runningNote(false),
      unavailableCopy("unlinked", "English"),
      linkConfirmCopy({ title: "Jane", language: "it", sourceTitle: "Jane", step: "person" }),
      nextStep([pair("it", "done", { result: result("it") })]) ?? "",
      applyWarning(row([target("it", "editedByHand")]), "it")?.message ?? "",
      ...optionsFor([
        target("it", "notTranslated", { hold: "timedOut" }),
        target("de", "notTranslated", { hold: "inRelease" }),
      ]).map(({ hint }) => hint ?? ""),
    ];

    for (const line of copy) {
      assert.doesNotMatch(line, DASHES, line);
    }
  });
});

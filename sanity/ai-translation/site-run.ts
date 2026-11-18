// The Settings > Translations whole-site panel's rules: the plan seen through this run's options, what blocks a run,
// the confirm and summary copy, and the free follow-up passes. Pure, so the panel is tested without rendering.

import { AI_TRANSLATION_DEFAULTS, AI_TRANSLATION_STYLE_GUIDE_LIMIT } from "../constants";
import { run as runBlock } from "../lib/run";
import type { ApiResult } from "./api";
import { requestTotalCopy } from "./dialog-model";
import { LABEL_BATCH_SIZE } from "./labels";
import {
  type CreditEstimate,
  estimateCredits,
  inBulk,
  type LabelItem,
  type PlanRow,
  RUN_ORDER,
  type RunStep,
  type TargetHold,
  TRANSLATION_STATUSES,
  type TranslationPlan,
  type TranslationStatus,
} from "./plan";
import {
  AI_USAGE_NOTE,
  aiRequestCount,
  askDeveloperToRun,
  DRAFT_HINT,
  formatNumber,
  handFixText,
  heldText,
  joinWords,
  languageName,
  linksCopy,
  requestsTodayCopy,
  runProgressCopy,
  type StatusText,
  statusText,
  unlinkedText,
} from "./present";
import {
  isRunActive,
  type PairJob,
  pairKey,
  type RunStepName,
  type RunTotals,
  runTotals,
  savedPairs,
  type TranslationRun,
  UPDATE_LINKS,
} from "./run-store";
import { type BulkPolicy, buildStyleGuide, readTranslationSettings, type TranslationLanguage } from "./style-guide";
import {
  type CreditsToday,
  FREE_PASS_BATCH,
  labelsForHandMessage,
  type PlanResponse,
  type PublishResult,
  type RelinkResult,
} from "./wire";

/** Above this many AI requests a run asks for the word typed out, not just a click. */
export const TYPED_CONFIRMATION_THRESHOLD = 50;
export const TYPED_CONFIRMATION_WORD = "translate";

/** The bounds of Settings' `maxCreditsPerRun`, which this run's own limit keeps. */
export const RUN_CREDIT_LIMIT_MIN = 1;
export const RUN_CREDIT_LIMIT_MAX = 500;

export const SITE_GROUP_TITLES: Readonly<Record<RunStepName, string>> = {
  labels: "Category names",
  person: "People",
  article: "Articles",
  legalPage: "Legal pages",
  // PLOP: Add Site Group Title
  page: "Pages",
  blog: "Blog index",
  homepage: "Homepage",
  site: "Site",
  relink: UPDATE_LINKS,
};

/** What the panel says instead of itself while Settings' published daily limit is 0. */
export const SWITCHED_OFF_NOTE =
  "Translate with AI is off: the AI request limit per day under Defaults is 0. Set it above 0 and publish to switch it on.";

/** Off hides the panel, but never a run this tab is still going through: its Stop and progress stay on screen. */
export function showsSwitchedOff(isOff: boolean, run: TranslationRun | null | undefined): boolean {
  return isOff && !isRunActive(run);
}

export type SiteRunOptions = {
  languages: string[];
  policy: BulkPolicy;
  slugs: "translate" | "keep";
  publish: boolean;
  maxCredits: number;
};

type PlanBasics = Pick<PlanResponse, "locales" | "defaultLocale">;

/** Every language but the default, in `LOCALES` order. */
export function targetLanguages(response: PlanBasics): TranslationLanguage[] {
  return response.locales.filter(({ id }) => id !== response.defaultLocale);
}

export function languageTitle(response: PlanBasics, id: string): string {
  return response.locales.find((language) => language.id === id)?.title ?? id;
}

/** A limit typed into the run's field: a whole number within Settings' bounds, else the fallback. */
export function runCreditLimit(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(number) || number < RUN_CREDIT_LIMIT_MIN) {
    return fallback;
  }

  return Math.min(RUN_CREDIT_LIMIT_MAX, Math.floor(number));
}

/** Settings' published defaults; languages no longer configured are dropped, and none left means all of them. */
export function defaultSiteRunOptions(response: PlanBasics & Pick<PlanResponse, "settings">): SiteRunOptions {
  const { defaults } = response.settings;
  const targets = targetLanguages(response).map(({ id }) => id);
  const chosen = defaults.languages.filter((id) => targets.includes(id));

  return {
    languages: chosen.length > 0 ? chosen : targets,
    policy: defaults.policy,
    slugs: defaults.slugs,
    publish: defaults.afterTranslate === "publish",
    maxCredits: runCreditLimit(defaults.maxCreditsPerRun, AI_TRANSLATION_DEFAULTS.maxCreditsPerRun),
  };
}

export type SiteCell = {
  language: string;
  status: TranslationStatus;
  bulk: boolean;
  targetId?: string;
  /** A paid result waits under Saved results, so the run leaves this pair out. */
  saved?: boolean;
  /** A category name in this language: no page, so no AI record to date it. */
  isName?: boolean;
  /** The language's own document already sits where the translation would go: link it instead. */
  unlinkedId?: string;
  /** That document's title, for the editor to confirm before linking it. */
  unlinkedTitle?: string;
  /** Held out of whole-site runs (`PlanTarget.hold`). */
  hold?: TargetHold;
  /** The AI's draft of it is not published yet. */
  aiDraft?: true;
  /** A category name the AI is never asked for. */
  handFix?: LabelItem["handFix"];
};

export type SiteRow = {
  id: string;
  /** The document the title opens: the source, or the category a name belongs to. */
  documentId: string;
  title: string;
  type: string;
  /** The default-language document was never published, so nothing translates it. */
  skipped: boolean;
  hasUnpublishedChanges: boolean;
  cells: SiteCell[];
};

export type SiteGroup = { step: RunStep; title: string; rows: SiteRow[] };

/** Each target counts once, in the first that holds: to link, held out of runs, an unpublished AI draft, its status. */
export type LanguageCounts = {
  toTranslate: number;
  byStatus: Record<TranslationStatus, number>;
  /** Targets whose language already has its own document there, to link as the translation. */
  unlinked: number;
  /** Targets a whole-site run leaves out whatever their status (`hold`). */
  held: number;
  /** Translations the AI saved as a draft nobody published: the site does not show them yet. */
  aiDrafts: number;
  /** Category names a run sends. */
  labels: number;
  /** Category names left for a hand fix. */
  labelsByHand: number;
  /** People (translated in place) a run sends, one call each. */
  people: number;
};

export type SitePlanView = {
  languages: TranslationLanguage[];
  /** The plan narrowed to this run's languages and policy: what `siteRunJobs` reads. */
  plan: TranslationPlan;
  groups: SiteGroup[];
  counts: Record<string, LanguageCounts>;
  /** Sources with at least one language to translate. */
  documents: number;
  pairs: number;
  labels: number;
  /** People a run translates in place, each once. */
  people: number;
  /** Category names, each once, left for a hand fix in a ticked language. */
  labelsByHand: number;
  estimate: CreditEstimate;
};

function emptyStatuses(): Record<TranslationStatus, number> {
  return Object.fromEntries(TRANSLATION_STATUSES.map((status) => [status, 0])) as Record<TranslationStatus, number>;
}

function narrowRow(row: PlanRow, languages: readonly string[], policy: BulkPolicy, saved: ReadonlySet<string>): PlanRow {
  return {
    ...row,
    targets: row.targets
      .filter(({ language }) => languages.includes(language))
      .map((target) => ({
        ...target,
        bulk:
          !row.skipped &&
          !target.unlinkedId &&
          !target.hold &&
          inBulk(target.status, policy) &&
          !saved.has(pairKey(row.sourceId, target.language)),
      })),
  };
}

function narrowLabels(labels: readonly LabelItem[], languages: readonly string[]): LabelItem[] {
  return labels.flatMap((label) => {
    const missing = label.missing.filter((language) => languages.includes(language));

    return missing.length > 0 ? [{ ...label, missing }] : [];
  });
}

/** The plan is read once for every language, so a run's languages and policy apply here, as the route applies them. */
export function sitePlanView(
  response: PlanBasics & Pick<PlanResponse, "plan"> & Partial<Pick<PlanResponse, "savedResults">>,
  options: Pick<SiteRunOptions, "languages" | "policy">
): SitePlanView {
  const languages = targetLanguages(response).filter(({ id }) => options.languages.includes(id));
  const ids = languages.map(({ id }) => id);
  const saved = savedPairs(response.savedResults);
  const isSaved = (sourceId: string, language: string) => saved.has(pairKey(sourceId, language));
  const rows = response.plan.rows.map((row) => narrowRow(row, ids, options.policy, saved));
  const labels = narrowLabels(response.plan.labels, ids);
  const askable = labels.filter(({ handFix, kind }) => !handFix && kind !== "document");
  const people = labels.filter(({ handFix, kind }) => !handFix && kind === "document");
  const labelBatches = [
    ...Array.from({ length: Math.ceil(askable.length / LABEL_BATCH_SIZE) }, (_, index) =>
      askable.slice(index * LABEL_BATCH_SIZE, (index + 1) * LABEL_BATCH_SIZE)
    ),
    ...people.flatMap((item) => item.missing.map((language) => [{ ...item, missing: [language] }])),
  ];
  const pairs = rows.reduce((total, row) => total + row.targets.filter(({ bulk }) => bulk).length, 0);
  const estimate = estimateCredits(
    pairs,
    askable.length,
    people.reduce((total, { missing }) => total + missing.length, 0)
  );
  const counts: Record<string, LanguageCounts> = Object.fromEntries(
    ids.map((id) => [
      id,
      { toTranslate: 0, byStatus: emptyStatuses(), unlinked: 0, held: 0, aiDrafts: 0, labels: 0, labelsByHand: 0, people: 0 },
    ])
  );

  for (const row of rows.filter(({ skipped }) => !skipped)) {
    for (const target of row.targets) {
      const count = counts[target.language] as LanguageCounts;

      if (target.unlinkedId) {
        count.unlinked += 1;
      } else if (target.hold) {
        count.held += 1;
      } else if (target.aiDraft) {
        count.aiDrafts += 1;
      } else {
        count.byStatus[target.status] += 1;
      }

      if (target.bulk) {
        count.toTranslate += 1;
      }
    }
  }

  for (const label of labels) {
    for (const language of label.missing) {
      const count = counts[language] as LanguageCounts;

      if (label.handFix) {
        count.labelsByHand += 1;
      } else if (label.kind === "document") {
        count.people += 1;
      } else {
        count.labels += 1;
      }
    }
  }

  const documentGroups: SiteGroup[] = RUN_ORDER.filter((step) => step !== "labels").map((step) => ({
    step,
    title: SITE_GROUP_TITLES[step],
    rows: rows
      .filter((row) => row.step === step)
      .map((row) => ({
        id: row.sourceId,
        documentId: row.sourceId,
        title: row.title,
        type: row.type,
        skipped: row.skipped !== undefined,
        hasUnpublishedChanges: row.hasUnpublishedChanges,
        cells: row.targets.map(({ language, status, bulk, targetId, unlinkedId, unlinkedTitle, hold, aiDraft }) => ({
          language,
          status,
          bulk,
          ...(targetId ? { targetId } : {}),
          ...(isSaved(row.sourceId, language) ? { saved: true } : {}),
          ...(unlinkedId ? { unlinkedId, ...(unlinkedTitle ? { unlinkedTitle } : {}) } : {}),
          ...(hold ? { hold } : {}),
          ...(aiDraft ? { aiDraft } : {}),
        })),
      })),
  }));
  const labelRows = (items: readonly LabelItem[]): SiteRow[] =>
    items.map((label) => ({
      id: `${label.id}.${label.field}`,
      documentId: label.id,
      title: label.text,
      type: label.type,
      skipped: false,
      hasUnpublishedChanges: false,
      cells: ids.map((language) => {
        const missing = label.missing.includes(language);

        return {
          language,
          status: missing ? ("notTranslated" as const) : ("upToDate" as const),
          bulk: missing && !label.handFix,
          isName: true,
          ...(missing && label.handFix ? { handFix: label.handFix } : {}),
        };
      }),
    }));
  const labelGroup: SiteGroup = {
    step: "labels",
    title: SITE_GROUP_TITLES.labels,
    rows: labelRows(labels.filter(({ kind }) => kind !== "document")),
  };
  // People have no translations to list: their fields translate in place, so their rows read like a category's.
  const personGroup: SiteGroup = {
    step: "person",
    title: SITE_GROUP_TITLES.person,
    rows: [
      ...labelRows(labels.filter(({ kind }) => kind === "document")),
      ...documentGroups.filter(({ step }) => step === "person").flatMap((group) => group.rows),
    ],
  };

  return {
    languages,
    plan: {
      ...response.plan,
      rows,
      labels,
      labelBatches,
      summary: Object.fromEntries(ids.map((id) => [id, response.plan.summary[id] ?? emptyStatuses()])),
      estimate,
    },
    groups: [labelGroup, personGroup, ...documentGroups.filter(({ step }) => step !== "person")].filter(
      (group) => group.rows.length > 0
    ),
    counts,
    documents: rows.filter((row) => row.targets.some(({ bulk }) => bulk)).length,
    pairs,
    labels: askable.length,
    people: people.length,
    labelsByHand: labels.filter(({ handFix }) => handFix).length,
    estimate,
  };
}

function counted(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** What the page list shows: only what a run would translate, or every page. */
export type PlanFilter = "toTranslate" | "all";

/** Rows a group shows before "Show more", and pages a list needs before it offers a search. */
export const PLAN_PAGE_SIZE = 20;
export const PLAN_SEARCH_MIN = 10;

export type FilteredGroup = SiteGroup & { total: number; toTranslate: number };

export function rowNeedsTranslation(row: SiteRow): boolean {
  return !row.skipped && row.cells.some((cell) => cell.bulk);
}

export function planTotals(groups: readonly SiteGroup[]): { rows: number; toTranslate: number } {
  const rows = groups.flatMap((group) => group.rows);

  return { rows: rows.length, toTranslate: rows.filter(rowNeedsTranslation).length };
}

/** Opens on what is left to translate, so a large site does not lead with hundreds of finished pages. */
export function defaultPlanFilter(groups: readonly SiteGroup[]): PlanFilter {
  return planTotals(groups).toTranslate > 0 ? "toTranslate" : "all";
}

/** The groups narrowed by the filter and a title search; a group with nothing left is dropped. */
export function filterPlanGroups(
  groups: readonly SiteGroup[],
  { filter, query }: { filter: PlanFilter; query: string }
): FilteredGroup[] {
  const needle = query.trim().toLocaleLowerCase();

  return groups.flatMap((group) => {
    const rows = group.rows.filter(
      (row) => (filter === "all" || rowNeedsTranslation(row)) && (needle === "" || row.title.toLocaleLowerCase().includes(needle))
    );

    return rows.length > 0
      ? [{ ...group, rows, total: group.rows.length, toTranslate: group.rows.filter(rowNeedsTranslation).length }]
      : [];
  });
}

/** "120 pages · 30 to translate", or "2 pages" when nothing in the group is left. */
export function groupCountsCopy(group: Pick<FilteredGroup, "total" | "toTranslate">): string {
  const total = counted(group.total, "page");

  return group.toTranslate > 0 ? `${total} · ${formatNumber(group.toTranslate)} to translate` : total;
}

/** "Show 20 more (100 left)": the next page of a long group, never more than what is left. */
export function showMoreCopy(left: number, pageSize = PLAN_PAGE_SIZE): string {
  return `Show ${formatNumber(Math.min(left, pageSize))} more (${formatNumber(left)} left)`;
}

/** "3 not translated yet, 6 translated": every live page with a translation counts as translated, AI or not. */
export function countsCopy(counts: LanguageCounts, source = "English"): string {
  const { byStatus } = counts;
  const translated =
    byStatus.upToDate + byStatus.englishChanged + byStatus.layoutChanged + byStatus.editedByHand + byStatus.translatedByHand;
  const parts = [
    ...(byStatus.notTranslated > 0 ? [`${formatNumber(byStatus.notTranslated)} not translated yet`] : []),
    ...(byStatus.copyOfEnglish > 0 ? [`${formatNumber(byStatus.copyOfEnglish)} still in ${source}`] : []),
    ...(translated > 0 ? [`${formatNumber(translated)} translated`] : []),
    ...(counts.aiDrafts > 0 ? [`${counted(counts.aiDrafts, "AI draft")} not published`] : []),
    ...(counts.held > 0 ? [`${formatNumber(counts.held)} left out of whole-site runs`] : []),
    ...(counts.unlinked > 0 ? [`${formatNumber(counts.unlinked)} not linked`] : []),
    ...(counts.labels > 0 ? [`${counted(counts.labels, "category name")} not translated yet`] : []),
    ...(counts.people > 0 ? [`${counted(counts.people, "person", "people")} not translated yet`] : []),
    ...(counts.labelsByHand > 0 ? [`${counted(counts.labelsByHand, "category name")} to fill in by hand`] : []),
  ];

  return parts.length > 0 ? parts.join(", ") : "nothing to translate";
}

const SAVED_CELL_HINT = "A paid result is saved: apply or discard it under Saved results, for free.";

/** A row's words in one language, as the document dialog says them; `translatedAt` dates an AI translation. */
export function cellText(cell: SiteCell, options: { source?: string; translatedAt?: string } = {}): StatusText {
  if (cell.handFix) {
    return handFixText(cell.handFix, options.source);
  }

  if (cell.isName) {
    return { text: cell.bulk ? "Not translated yet" : "Translated" };
  }

  if (cell.unlinkedId) {
    return unlinkedText(options.source);
  }

  const status = statusText(cell.status, options);
  const words = cell.hold ? heldText(cell.hold, status) : status;
  const hint = [words.hint, cell.aiDraft ? DRAFT_HINT : undefined, cell.saved ? SAVED_CELL_HINT : undefined]
    .filter(Boolean)
    .join(" ");

  return hint ? { text: words.text, hint } : { text: words.text };
}

/** Under "Every page is translated": category names that wait for a hand fix are not done either. */
export function allDoneNote(view: Pick<SitePlanView, "labelsByHand">): string | undefined {
  return view.labelsByHand > 0 ? labelsForHandMessage(view.labelsByHand) : undefined;
}

export function translateButtonText(view: Pick<SitePlanView, "documents" | "labels"> & { people?: number }): string {
  if (view.documents > 0) {
    return `Translate ${counted(view.documents, "page")}`;
  }

  if (view.labels > 0) {
    return `Translate ${counted(view.labels, "category name")}`;
  }

  if ((view.people ?? 0) > 0) {
    return `Translate ${counted(view.people ?? 0, "person", "people")}`;
  }

  return "Nothing to translate";
}

export type RunBlock = { code: string; message: string };

type BlockSource = Pick<PlanResponse, "blocked" | "creditsToday" | "schema">;

/** Everything that would make the route refuse a run now, for the banners. */
export function runBlocks(response: BlockSource): RunBlock[] {
  const { used, max } = response.creditsToday;
  const blocks: RunBlock[] = [];

  if (!response.schema.ok || response.blocked?.code === "schema_drift") {
    blocks.push({
      code: "schema_drift",
      message:
        "Translating is paused: the deployed schema is out of date. Ask a developer to run npm run sanity:schema-deploy, then refresh the plan.",
    });
  }

  if (used >= max) {
    blocks.push({
      code: "daily_cap",
      message: `Today's AI request limit is reached (${formatNumber(used)} of ${formatNumber(max)}). Raise the daily limit under Defaults and publish, or try again tomorrow (UTC).`,
    });
  }

  return blocks;
}

/** Why the Translate button is disabled, or null; a run over its limit starts and stops at it. */
export function startBlock(options: {
  view: Pick<SitePlanView, "documents" | "labels" | "languages"> & { people?: number };
  response: BlockSource;
}): RunBlock | null {
  const { view, response } = options;

  if (view.languages.length === 0) {
    return { code: "no_languages", message: "Pick at least one language." };
  }

  if (view.documents === 0 && view.labels === 0 && (view.people ?? 0) === 0) {
    return { code: "nothing", message: "Nothing to translate in these languages with this choice." };
  }

  const [blocked] = runBlocks(response);

  return blocked ?? null;
}

/** What this run may spend: the estimate, or the run's limit when the estimate is over it. */
export function runSpend(estimate: Pick<CreditEstimate, "credits">, maxCredits: number): number {
  return Math.min(estimate.credits, maxCredits);
}

/** "5 AI requests", or "500 of 620 AI requests this run" when the run stops at its limit. */
export function runCostCopy(estimate: Pick<CreditEstimate, "credits">, maxCredits: number): string {
  if (estimate.credits <= maxCredits) {
    return estimate.credits > 0 ? aiRequestCount(estimate.credits) : "No AI requests";
  }

  return `${formatNumber(maxCredits)} of ${aiRequestCount(estimate.credits)} this run`;
}

/** Counted on what the run may spend, so a run stopped by a low limit asks only for a click. */
export function needsTypedConfirmation(credits: number): boolean {
  return credits > TYPED_CONFIRMATION_THRESHOLD;
}

export function isConfirmationTyped(value: string): boolean {
  return value.trim().toLowerCase() === TYPED_CONFIRMATION_WORD;
}

/** The confirm Dialog: what runs, what it costs, what happens after, and what is left alone. */
export function confirmCopy(options: {
  view: Pick<SitePlanView, "documents" | "labels" | "estimate" | "languages" | "counts"> & { people?: number };
  run: SiteRunOptions;
  response: Pick<PlanResponse, "creditsToday" | "locales" | "defaultLocale">;
}): { summary: string; lines: string[]; cautions: string[] } {
  const { view, run, response } = options;
  const source = languageName(response.defaultLocale);
  const what = [
    ...(view.documents > 0 ? [counted(view.documents, "page")] : []),
    ...(view.labels > 0 ? [counted(view.labels, "category name")] : []),
    ...((view.people ?? 0) > 0 ? [counted(view.people ?? 0, "person", "people")] : []),
  ];
  const summary = `${joinWords(what)} into ${joinWords(view.languages.map(({ id }) => languageName(id)))}.`;
  const perLanguage =
    view.languages.length > 1
      ? view.languages.map(({ id, title }) => `${title}: ${counted(view.counts[id]?.toTranslate ?? 0, "page")}`)
      : [];
  const { used, max } = response.creditsToday;
  const left = Math.max(0, max - used);
  const credits = view.estimate.credits;
  const spend = runSpend(view.estimate, run.maxCredits);
  const isOverLimit = credits > run.maxCredits;
  const lines = [
    ...perLanguage,
    isOverLimit
      ? `Makes up to ${aiRequestCount(spend)}, this run's limit. ${AI_USAGE_NOTE}`
      : `Makes ${credits > 0 ? aiRequestCount(credits) : "no AI requests"}. ${AI_USAGE_NOTE}`,
    run.publish
      ? "Each translation is published as soon as it is done, then the links on other pages are updated to point at it."
      : "Everything is saved as drafts to review.",
    run.policy === "refresh"
      ? `AI translations whose ${source} was updated are translated again.`
      : `Only pages not translated yet are translated; AI translations whose ${source} was updated stay as they are.`,
    "Pages edited since the AI translation or written by hand are left as they are.",
    `${requestsTodayCopy({ used, max })}.`,
  ];
  const cautions = [
    ...(isOverLimit
      ? [
          `This run needs ${aiRequestCount(credits)}, over its limit of ${formatNumber(run.maxCredits)}: it stops there, with about ${formatNumber(spend)} of the ${formatNumber(credits)} translations done. ${run.publish ? "Translate the site again" : "Publish its drafts, then translate the site again"} to continue: the next run picks up the rest.`,
        ]
      : []),
    ...(spend > left ? [`Only ${aiRequestCount(left)} left today: the run stops at today's limit.`] : []),
  ];

  return { summary, lines, cautions };
}

/** "Stop after the 2 running"; the queue only waits for requests already sent. */
export function stopButtonText(run: Pick<TranslationRun, "status">, totals: Pick<RunTotals, "running">): string {
  if (run.status === "stopping") {
    return "Stopping...";
  }

  if (totals.running === 0) {
    return "Stop";
  }

  return `Stop after the ${formatNumber(totals.running)} running`;
}

/** The panel's `aria-live` text: it stays mounted, so the end of a run is announced too; the timer stays outside it. */
export function siteRunAnnouncement(run: TranslationRun | null | undefined): string {
  if (!run) {
    return "";
  }

  if (isRunActive(run)) {
    return runProgressCopy(runTotals(run));
  }

  return `${run.status === "stopped" ? "Translation stopped" : "Translation finished"}. ${runSummary(run).headline}`;
}

/** Said while a free pass runs behind a spinner; its outcome is a toast, which announces itself. */
export function panelBusyCopy(busy: { isUpdatingLinks?: boolean; isPublishing?: boolean }): string {
  if (busy.isPublishing) {
    return "Publishing the AI drafts.";
  }

  return busy.isUpdatingLinks ? "Updating links." : "";
}

/** What "Publish N AI drafts" sends: every unpublished AI draft the plan lists, whatever run left it. */
export type DraftsToPublish = {
  ids: string[];
  translations: number;
  categoryNames: number;
};

/** From the plan, never a run's summary, so a reload, Dismiss or a later run keeps them; the route proves category drafts. */
export function draftsToPublish(response: Pick<PlanResponse, "plan"> | null | undefined): DraftsToPublish {
  const ids = [...new Set(response?.plan.aiDrafts ?? [])];
  const targets = new Set(response?.plan.rows.flatMap(({ targets }) => targets.flatMap(({ targetId }) => targetId ?? [])));
  const translations = ids.filter((id) => targets.has(id)).length;

  return { ids, translations, categoryNames: ids.length - translations };
}

function draftsWhat(drafts: DraftsToPublish, words: { translation: string; categoryName: string }): string {
  return joinWords([
    ...(drafts.translations > 0 ? [counted(drafts.translations, words.translation)] : []),
    ...(drafts.categoryNames > 0 ? [counted(drafts.categoryNames, words.categoryName)] : []),
  ]);
}

/** "2 translations and 1 category name the AI wrote are saved as drafts, not published yet." */
export function aiDraftsCopy(drafts: DraftsToPublish): string {
  const what = draftsWhat(drafts, { translation: "translation", categoryName: "category name" });

  return `${what} the AI wrote ${drafts.ids.length === 1 ? "is saved as a draft" : "are saved as drafts"}, not published yet.`;
}

/** "Publish 3 AI drafts". */
export function publishButtonText(drafts: Pick<DraftsToPublish, "ids">): string {
  return `Publish ${counted(drafts.ids.length, "AI draft")}`;
}

/** The publish Dialog: what is published, what stays a draft, and Update links after it. */
export function publishConfirmCopy(drafts: DraftsToPublish): string {
  const what = draftsWhat(drafts, { translation: "translation draft", categoryName: "category name draft" });

  return `Publishes the ${what} the AI wrote, then runs ${UPDATE_LINKS} (free), so the published translations link to each other's pages. A draft edited since the AI wrote it stays a draft, and is listed after.`;
}

/** The newest daily count a result carried, fresher than the plan read before the run. */
export function latestCreditsToday(run: TranslationRun | null | undefined): CreditsToday | undefined {
  const counted = (run?.jobs ?? []).flatMap((job) =>
    (job.kind === "pair" || job.kind === "labels") && job.finishedAt !== undefined && job.result?.credits
      ? [{ at: job.finishedAt, credits: job.result.credits }]
      : []
  );

  return counted.sort((a, b) => b.at - a.at)[0]?.credits;
}

/** The later of the run's newest count and the plan's: both only grow within a UTC day. */
export function freshestCreditsToday(
  run: TranslationRun | null | undefined,
  plan: CreditsToday | undefined
): CreditsToday | undefined {
  const fromRun = latestCreditsToday(run);

  if (!fromRun || !plan) {
    return fromRun ?? plan;
  }

  if (fromRun.day !== plan.day) {
    return fromRun.day > plan.day ? fromRun : plan;
  }

  return fromRun.used > plan.used ? fromRun : plan;
}

export type RunFailure = { id: string; title: string; language?: string; message: string };

export type RunSummary = {
  tone: "positive" | "caution";
  headline: string;
  credits: string;
  /** Why it stopped early, when it did. */
  stopped?: string;
  failures: RunFailure[];
  /** Paid results kept on the server: "Apply saved result (free)". */
  savedResults: { sourceId: string; language: string; title: string }[];
  published: number;
  categoryNames: number;
};

/** The done Card: counts, why it stopped, each failure with its reason, and what was saved for later. */
export function runSummary(run: TranslationRun): RunSummary {
  const totals = runTotals(run);
  const pairs = run.jobs.filter((job): job is PairJob => job.kind === "pair");
  const count = (state: string) => pairs.filter((job) => job.state === state).length;
  const categoryNames = run.jobs.reduce((total, job) => {
    if (job.kind !== "labels" || !job.result) {
      return total;
    }

    // A refused batch may still have written the names a saved answer held.
    const written = job.result.written?.length ?? (job.state === "done" ? Object.keys(job.result.labels ?? {}).length : 0);

    return total + written;
  }, 0);
  const notStarted = count("stopped");
  const parts = [
    `${formatNumber(count("done"))} translated`,
    ...(categoryNames > 0 ? [`${counted(categoryNames, "category name")} filled`] : []),
    ...(count("skipped") > 0 ? [`${formatNumber(count("skipped"))} skipped`] : []),
    `${formatNumber(totals.failed)} failed`,
    ...(totals.savedResults > 0 ? [`${formatNumber(totals.savedResults)} saved, not applied`] : []),
    ...(notStarted > 0 ? [`${formatNumber(notStarted)} not started`] : []),
  ];
  const credits = `${requestTotalCopy(run)}.`;
  const stoppedEarly = run.status === "stopped" && run.stopReason !== undefined;
  const failures = run.jobs
    .filter((job) => job.state === "failed")
    .map((job) => ({
      id: job.id,
      title: job.title,
      ...(job.kind === "pair" ? { language: job.language } : {}),
      message: job.message ?? job.failure?.message ?? "Failed.",
    }));
  const savedResults = pairs
    .filter((job) => job.state === "saved_result")
    .map(({ sourceId, language, title }) => ({ sourceId, language, title }));
  const troubled = failures.length > 0 || savedResults.length > 0 || (stoppedEarly && run.stopReason?.code !== "stopped");

  return {
    tone: troubled ? "caution" : "positive",
    headline: `${parts.join(", ")}.`,
    credits,
    ...(stoppedEarly ? { stopped: run.stopReason?.message } : {}),
    failures,
    savedResults,
    published: pairs.filter((job) => job.state === "done" && job.result?.published === true).length,
    categoryNames,
  };
}

/** 50 per request; an id the route had no time left for goes again once. */
export async function publishInBatches(
  send: (ids: string[], revs: Record<string, string>) => Promise<ApiResult<PublishResult>>,
  ids: readonly string[],
  revs: Readonly<Record<string, string>> = {}
): Promise<ApiResult<PublishResult>> {
  const total: PublishResult = { published: [], skipped: [] };
  const queue = [...ids];
  const resent = new Set<string>();

  while (queue.length > 0) {
    const batch = queue.splice(0, FREE_PASS_BATCH);
    const batchRevs = Object.fromEntries(batch.flatMap((id) => (revs[id] ? [[id, revs[id]]] : [])));
    const answer = await send(batch, batchRevs);

    if (!answer.ok) {
      return answer;
    }

    total.published.push(...answer.data.published);

    for (const item of answer.data.skipped) {
      if (item.code === "out_of_time" && !resent.has(item.id)) {
        resent.add(item.id);
        queue.push(item.id);
      } else {
        total.skipped.push(item);
      }
    }
  }

  return { ok: true, data: total };
}

/** "3 drafts published, 1 left as a draft.", then Update links' outcome when it ran. */
export function publishCopy(result: PublishResult, relinked?: ApiResult<RelinkResult>): string {
  const published = `${counted(result.published.length, "draft")} published`;
  const left = result.skipped.length;
  const skipped = left > 0 ? `, ${left === 1 ? "1 left as a draft" : `${formatNumber(left)} left as drafts`}` : "";
  const links = runBlock(() => {
    if (!relinked) {
      return "";
    }
    if (relinked.ok) {
      return ` ${linksCopy(relinked.data, true)}`;
    }
    return ` Links were not updated: use ${UPDATE_LINKS} in the menu above.`;
  });

  return `${published}${skipped}.${links}`;
}

export type SkippedDraft = { id: string; title: string; reason: string };

/** Each draft "Publish" left as it is, named from the plan (and a run's own names), with the route's fixed reason. */
export function skippedDrafts(
  result: PublishResult,
  from: { response?: Pick<PlanResponse, "plan"> | null; run?: TranslationRun | null }
): SkippedDraft[] {
  const names = new Map<string, string>();

  for (const row of from.response?.plan.rows ?? []) {
    for (const { targetId, language } of row.targets) {
      if (targetId) {
        names.set(targetId, `${row.title} (${languageName(language)})`);
      }
    }
  }

  for (const label of from.response?.plan.labels ?? []) {
    names.set(label.id, `Category: ${label.text}`);
  }

  for (const job of from.run?.jobs ?? []) {
    if (job.kind === "labels") {
      for (const [id, written] of Object.entries(job.result?.labels ?? {})) {
        const name = Object.values(written)[0];

        names.set(id, name ? `Category name: ${name}` : "Category name");
      }
    }
  }

  return result.skipped.map(({ id, reason }) => ({ id, title: names.get(id) ?? id, reason }));
}

export type SavedResultItem = { sourceId: string; language: string; title: string; languageTitle: string; savedAt: string };

export function savedResultItems(response: PlanBasics & Pick<PlanResponse, "plan" | "savedResults">): SavedResultItem[] {
  return response.savedResults.map(({ sourceId, language, savedAt }) => ({
    sourceId,
    language,
    savedAt,
    title: response.plan.rows.find((row) => row.sourceId === sourceId)?.title ?? sourceId,
    languageTitle: languageTitle(response, language),
  }));
}

export type StyleGuideRoom = { language: TranslationLanguage; length: number; remaining: number; ok: boolean };

/** Each language's compiled guide (style guide, its notes and glossary) against Sanity's cap, from the form's value. */
export function styleGuideRoom(value: unknown, languages: readonly TranslationLanguage[]): StyleGuideRoom[] {
  const settings = readTranslationSettings(value);

  return languages.map((language) => {
    const guide = buildStyleGuide(settings, language);

    return { language, length: guide.length, remaining: AI_TRANSLATION_STYLE_GUIDE_LIMIT - guide.length, ok: guide.ok };
  });
}

export function styleGuideRoomCopy(room: StyleGuideRoom, single: boolean): string {
  const limit = formatNumber(AI_TRANSLATION_STYLE_GUIDE_LIMIT);
  const used = `${formatNumber(room.length)} / ${limit}`;
  const left = room.ok
    ? `${counted(room.remaining, "character")} left`
    : `${counted(-room.remaining, "character")} over, shorten it`;

  return single ? `${used}, ${left}` : `${room.language.title}: ${used}, ${left}`;
}

export function plainLabelsCopy(count: number): string {
  const which = count === 1 ? "1 category name is" : `${formatNumber(count)} category names are`;

  return `${which} still plain text, not one per language, and left out. ${askDeveloperToRun("sanity:migrate-localize-fields")}`;
}

export function missingLanguageCopy(count: number): string {
  const which =
    count === 1 ? "1 document has no language yet and is" : `${formatNumber(count)} documents have no language yet and are`;

  return `${which} left out. ${askDeveloperToRun("sanity:migrate-backfill-language")}`;
}

// The Translate with AI dialog's rules, out of React so they are tested: which languages start ticked, what a run
// sends and costs, what blocks it, and the words for its progress and outcome. See docs/features/ai-translation.md

import type { CardTone } from "@sanity/ui";
import { AI_TRANSLATION_STYLE_GUIDE_LIMIT } from "../constants";
import { getStudioLocaleTitle } from "../i18n";
import type { ApiResult } from "./api";
import { isPlainObject } from "./fields";
import {
  inBulk,
  type LabelItem,
  needsWork,
  type PlanRow,
  type PlanTarget,
  RUN_ORDER,
  type RunStep,
  requiresOverwrite,
  type TargetHold,
  type TranslationStatus,
} from "./plan";
import {
  aiRequestCount,
  askDeveloperToRun,
  DRAFT_HINT,
  formatDay,
  formatDuration,
  formatNumber,
  handFixText,
  heldText,
  joinWords,
  languageName,
  linksCopy,
  PUBLISH_ACCESS_TEXT,
  requestsMadeCopy,
  statusLine,
  statusText,
  unlinkedText,
  wordCountCopy,
} from "./present";
import {
  isRunActive,
  type JobInput,
  type LabelsJob,
  type PairJob,
  type RelinkJob,
  type RunJob,
  runTotals,
  STOP_CODES,
  type TranslationRun,
  UPDATE_LINKS,
} from "./run-store";
import { RUN_INSTRUCTIONS_LIMIT } from "./style-guide";
import {
  type DiscardResult,
  type LinkResult,
  type PairResult,
  type PlanResponse,
  type RelinkResult,
  type SavedResultSummary,
  TRANSLATE_MESSAGES,
} from "./wire";

export const ACTION_LABEL = "Translate with AI";

/** `buildStyleGuide` joins its parts with a blank line, which the run's instructions share the cap with. */
const STYLE_GUIDE_SEPARATOR_LENGTH = 2;

const SANITY_MANAGE_URL = "https://www.sanity.io/manage";

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

function languageCount(count: number): string {
  return plural(count, "language");
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "an English page", "a German page". */
function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;
}

/** Settings' AI request limit per day at 0 switches Translate with AI off; unset means the default limit, so on. */
export function isTranslateSwitchedOff(siteSettings: unknown): boolean {
  const translations = isPlainObject(siteSettings) ? siteSettings.translations : undefined;
  const defaults = isPlainObject(translations) ? translations.defaults : undefined;

  return isPlainObject(defaults) && defaults.maxCreditsPerDay === 0;
}

export type ActionState = { hidden: boolean; disabled: boolean; label: string; title?: string };

export type ActionInput = {
  hasDocument: boolean;
  /** A release version: out of scope for v1. */
  isVersion: boolean;
  isCategory: boolean;
  language: unknown;
  defaultLocale: string;
  /** This source's pairs in the tab's run (`sourceProgress`). */
  progress: { total: number; finished: number; active: boolean } | null;
  /** Settings' daily limit is 0 (`isTranslateSwitchedOff`). */
  isOff?: boolean;
  /** The editor's publish permission on this document; unset while it loads, since the route checks it anyway. */
  canPublish?: boolean;
};

/** The action button: its label shows a run's progress, and it stays clickable so the dialog can show or stop it. */
export function translateActionState(input: ActionInput): ActionState {
  if (input.isVersion || (input.isOff && !input.progress?.active)) {
    return { hidden: true, disabled: true, label: ACTION_LABEL };
  }

  if (!input.hasDocument) {
    return {
      hidden: false,
      disabled: true,
      label: ACTION_LABEL,
      title: "Save this document first: there is nothing to translate yet.",
    };
  }

  if (input.canPublish === false && !input.progress?.active) {
    return { hidden: false, disabled: true, label: ACTION_LABEL, title: PUBLISH_ACCESS_TEXT };
  }

  if (!input.isCategory && (typeof input.language !== "string" || input.language === "")) {
    return { hidden: false, disabled: true, label: ACTION_LABEL, title: TRANSLATE_MESSAGES.missing_language };
  }

  if (input.progress?.active) {
    return {
      hidden: false,
      disabled: false,
      label: `Translating... ${formatNumber(input.progress.finished)} of ${formatNumber(input.progress.total)}`,
      title: "Open to follow the translation or stop it.",
    };
  }

  if (!input.isCategory && input.language !== input.defaultLocale) {
    return {
      hidden: false,
      disabled: false,
      label: ACTION_LABEL,
      title: `Translations are made from the ${languageName(input.defaultLocale)} page.`,
    };
  }

  return { hidden: false, disabled: false, label: ACTION_LABEL };
}

/** Every language the site translates into, in `LOCALES` order. */
export function targetLanguages(response: Pick<PlanResponse, "locales" | "defaultLocale">): string[] {
  return response.locales.map(({ id }) => id).filter((id) => id !== response.defaultLocale);
}

/** What the open document is to the plan: a source, one of its translations, a category, or none of these. */
export type DialogSubject =
  | { kind: "source"; row: PlanRow }
  | { kind: "translation"; row: PlanRow; target: PlanTarget }
  | { kind: "category"; label: LabelItem | undefined; plain?: true }
  | { kind: "missingLanguage" }
  | { kind: "unlinked" };

export function dialogSubject(
  response: Pick<PlanResponse, "plan">,
  documentId: string,
  options: { isCategory: boolean }
): DialogSubject {
  const { plan } = response;

  if (options.isCategory) {
    const label = plan.labels.find(({ id }) => id === documentId);

    return plan.plainLabels?.includes(documentId) ? { kind: "category", label, plain: true } : { kind: "category", label };
  }

  if (plan.missingLanguage.includes(documentId)) {
    return { kind: "missingLanguage" };
  }

  const row = plan.rows.find(({ sourceId }) => sourceId === documentId);

  if (row) {
    return { kind: "source", row };
  }

  for (const candidate of plan.rows) {
    const target = candidate.targets.find(({ targetId }) => targetId === documentId);

    if (target) {
      return { kind: "translation", row: candidate, target };
    }
  }

  return { kind: "unlinked" };
}

/** What ticking a row with a page replaces; hand changes also need the editor's acknowledgement. */
export type ReplaceWarning = { message: string; acknowledgement?: string };

const AI_MADE: ReadonlySet<TranslationStatus> = new Set(["upToDate", "englishChanged", "layoutChanged"]);

/** `name` and `source` are languages in prose ("Italian", "English"); a copy of the source or no page replaces nothing. */
export function replaceWarning(status: TranslationStatus, name: string, source: string): ReplaceWarning | undefined {
  const isHandWritten = requiresOverwrite(status);

  if (!isHandWritten && !AI_MADE.has(status)) {
    return undefined;
  }

  const message = `Replaces the ${name} page with a fresh translation of the ${source}. Changes and sections that exist only in ${name} are lost. Its URL, Password protect and No Index stay as they are.`;

  return isHandWritten ? { message, acknowledgement: `I understand the ${name} changes are replaced` } : { message };
}

export type TargetOption = {
  language: string;
  /** The flag and native title, for the row's label. */
  title: string;
  /** "Italian", for sentences. */
  name: string;
  status: TranslationStatus;
  text: string;
  hint?: string;
  uri?: string;
  targetId?: string;
  hasDraft: boolean;
  /** The language's own document already sits there: the route refuses, so it cannot be ticked, only linked. */
  unlinkedId?: string;
  /** That document's title or name, for the editor to confirm before linking it. */
  unlinkedTitle?: string;
  /** Held out of whole-site runs (`PlanTarget.hold`). */
  hold?: TargetHold;
  /** The route would refuse it (an unlinked document there, or a translation only inside a release). */
  isLocked: boolean;
  /** A paid result waits for this language: ticking it anyway asks the route to pay again. */
  hasSavedResult: boolean;
  warning?: ReplaceWarning;
  preselected: boolean;
};

const SAVED_HINT = "A paid result is saved: apply it below for free, or tick this language to translate again.";

function optionText(target: PlanTarget, source: string, translatedAt: string | undefined) {
  if (target.unlinkedId) {
    return unlinkedText(source);
  }

  const words = statusText(target.status, { source, translatedAt });

  return target.hold ? heldText(target.hold, words) : words;
}

/** Ticked from the start: no page yet, or one still in the source language, in Settings' default languages when offered. */
export function targetOptions(
  row: Pick<PlanRow, "targets">,
  options: {
    source: string;
    defaultLanguages?: readonly string[];
    /** Languages with a saved result, which a run would pay for a second time. */
    saved?: readonly string[];
    /** `aiTranslation.translatedAt` by translation id. */
    translatedAt?: Readonly<Record<string, string>>;
  }
): TargetOption[] {
  const offered = row.targets.map(({ language }) => language);
  const preferred = (options.defaultLanguages ?? []).filter((language) => offered.includes(language));

  return row.targets.map((target) => {
    const name = languageName(target.language);
    const translatedAt = target.targetId ? options.translatedAt?.[target.targetId] : undefined;
    const { text, hint } = optionText(target, options.source, translatedAt);
    const isSaved = options.saved?.includes(target.language) === true;
    const isLocked = target.unlinkedId !== undefined || target.hold === "inRelease";
    const hints = [hint, target.aiDraft ? DRAFT_HINT : undefined, isSaved ? SAVED_HINT : undefined].filter(Boolean).join(" ");
    const warning = replaceWarning(target.status, name, options.source);

    return {
      language: target.language,
      title: getStudioLocaleTitle(target.language),
      name,
      status: target.status,
      text,
      ...(hints ? { hint: hints } : {}),
      ...(target.uri ? { uri: target.uri } : {}),
      ...(target.targetId ? { targetId: target.targetId } : {}),
      hasDraft: target.hasDraft,
      ...(target.unlinkedId ? { unlinkedId: target.unlinkedId } : {}),
      ...(target.unlinkedTitle ? { unlinkedTitle: target.unlinkedTitle } : {}),
      ...(target.hold ? { hold: target.hold } : {}),
      isLocked,
      hasSavedResult: isSaved,
      ...(warning ? { warning } : {}),
      preselected:
        inBulk(target.status, "missing") &&
        !isSaved &&
        !isLocked &&
        !target.hold &&
        (preferred.length === 0 || preferred.includes(target.language)),
    };
  });
}

export type TargetPick = { selected: boolean; acknowledged: boolean };

export type TargetPicks = Readonly<Record<string, TargetPick>>;

const UNPICKED: TargetPick = { selected: false, acknowledged: false };

export function initialPicks(options: readonly TargetOption[]): TargetPicks {
  return Object.fromEntries(options.map((option) => [option.language, { selected: option.preselected, acknowledged: false }]));
}

/** Ticking or unticking a row clears its acknowledgement, so each replacement of hand changes is agreed to afresh. */
export function selectTarget(picks: TargetPicks, option: TargetOption, selected: boolean): TargetPicks {
  return { ...picks, [option.language]: { selected, acknowledged: false } };
}

export function acknowledgeTarget(picks: TargetPicks, option: TargetOption, acknowledged: boolean): TargetPicks {
  const current = picks[option.language] ?? UNPICKED;

  return current.selected ? { ...picks, [option.language]: { selected: true, acknowledged } } : picks;
}

/** Ticked rows that replace hand changes the editor has not acknowledged yet: Translate waits for them. */
export function unacknowledgedTargets(options: readonly TargetOption[], picks: TargetPicks): TargetOption[] {
  return options.filter((option) => {
    const pick = picks[option.language] ?? UNPICKED;

    return pick.selected && option.warning?.acknowledgement !== undefined && !pick.acknowledged;
  });
}

export type RunPick = { language: string; overwrite: boolean };

/** What `documentRunJobs` takes: whatever the server would skip, or holds a saved result, goes with `overwrite`. */
export function runPicks(options: readonly TargetOption[], picks: TargetPicks): RunPick[] {
  return options
    .filter((option) => (picks[option.language] ?? UNPICKED).selected && !option.isLocked)
    .map((option) => ({ language: option.language, overwrite: !needsWork(option.status) || option.hasSavedResult }));
}

/** Only these get a slug from their title; the homepage, the blog index, a person and the Site keep a fixed path. */
const OWN_SLUG_STEPS: ReadonlySet<RunStep> = new Set<RunStep>([
  "page",
  "article",
  "legalPage",
  // PLOP: Add Own Slug Step
]);

export function hasOwnSlug(step: RunStep): boolean {
  return OWN_SLUG_STEPS.has(step);
}

/** A category's run: one label batch for its missing languages; a person's, one call per language. Never for a hand fix. */
export function categoryJobs(
  id: string,
  label: (Pick<LabelItem, "missing" | "handFix"> & Partial<Pick<LabelItem, "kind" | "text">>) | undefined,
  publish: boolean
): JobInput[] {
  if (!label || label.missing.length === 0 || label.handFix) {
    return [];
  }

  if (label.kind === "document") {
    return label.missing.map((language) => ({
      kind: "labels",
      title: `${label.text ?? id} (${getStudioLocaleTitle(language)})`,
      input: { ids: [id], languages: [language], publish },
    }));
  }

  return [{ kind: "labels", title: "Category name", input: { ids: [id], languages: [...label.missing], publish } }];
}

function isRunStep(step: string): step is RunStep {
  return (RUN_ORDER as readonly string[]).includes(step);
}

/** What "Try again" queues: failures that may pass now, and jobs a stop kept from starting; never a stop code. */
export function retryJobs(run: TranslationRun, jobs: readonly RunJob[], leaveOut: ReadonlySet<string> = new Set()): JobInput[] {
  if (run.stopReason && STOP_CODES.has(run.stopReason.code)) {
    return [];
  }

  const isRetryable = (job: RunJob) =>
    !leaveOut.has(job.id) && (job.state === "stopped" || (job.state === "failed" && !STOP_CODES.has(job.code ?? "")));
  const paid = jobs.flatMap((job): JobInput[] => {
    if (!isRetryable(job)) {
      return [];
    }

    if (job.kind === "pair" && isRunStep(job.step)) {
      // A lost answer may have written it already: only the server's own re-check may decide to pay again.
      const isLost = job.creditMayBeSpent && !job.creditSpent;
      const input = isLost ? { ...job.input, overwrite: false } : job.input;

      return [{ kind: "pair", step: job.step, title: job.title, input }];
    }

    return job.kind === "labels" ? [{ kind: "labels", title: job.title, input: job.input }] : [];
  });
  const links = jobs.find((job) => job.kind === "relink");
  // Links follow whatever the retry publishes, or go again on their own when they were what failed.
  const linksAgain = links?.kind === "relink" && (paid.length > 0 || isRetryable(links));

  return linksAgain ? [...paid, { kind: "relink", title: links.title, input: links.input }] : paid;
}

export function retryLabel(credits: number): string {
  return credits > 0 ? "Try again" : "Try again (free)";
}

/** Room for the run's instructions: the server's own cap, or what the tightest language's guide leaves of 2,000. */
export function instructionsRoom(byLanguage: Readonly<Record<string, number>>, languages: readonly string[]): number {
  const rooms = languages.map((language) => {
    const base = byLanguage[language] ?? 0;

    return AI_TRANSLATION_STYLE_GUIDE_LIMIT - base - (base > 0 ? STYLE_GUIDE_SEPARATOR_LENGTH : 0);
  });

  return Math.max(0, Math.min(RUN_INSTRUCTIONS_LIMIT, ...rooms));
}

/** Negative when the instructions are too long. */
export function instructionsLeft(room: number, instructions: string): number {
  return room - instructions.trim().length;
}

export function charactersLeftCopy(left: number): string {
  return left >= 0 ? `${plural(left, "character")} left` : `${plural(-left, "character")} too many`;
}

export type NoticeAction = "openSettings" | "openUsage";

export type Notice = { id: string; tone: CardTone; message: string; blocking: boolean; action?: NoticeAction };

export type StartCheck = {
  response: Pick<PlanResponse, "blocked" | "creditsToday" | "settings">;
  /** Paid jobs the run would queue. */
  credits: number;
  otherRunActive: boolean;
  /** `instructionsLeft`; negative blocks. */
  charactersLeft: number;
};

/** Banners above the footer, only those that apply, blocking ones first: the start button waits while any blocks. */
export function startNotices(check: StartCheck): Notice[] {
  const { response, credits } = check;
  const { used, max } = response.creditsToday;
  const perRun = response.settings.defaults.maxCreditsPerRun;
  const notices: Notice[] = [];

  if (check.otherRunActive) {
    notices.push({
      id: "busy",
      tone: "caution",
      blocking: true,
      message: "Another translation run is going in this tab. Wait for it to finish, or stop it where it started.",
    });
  }

  if (response.blocked?.code === "schema_drift") {
    notices.push({ id: "schema_drift", tone: "critical", blocking: true, message: TRANSLATE_MESSAGES.schema_drift });
  }

  if (used >= max) {
    notices.push({
      id: "daily_cap",
      tone: "critical",
      blocking: true,
      action: "openSettings",
      message: `Today's limit of ${aiRequestCount(max)} from Settings > Translations is reached. It resets at midnight UTC.`,
    });
  } else if (credits > 0 && used + credits > max) {
    notices.push({
      id: "daily_left",
      tone: "caution",
      blocking: false,
      message: `Only ${aiRequestCount(max - used)} left today: the run stops when today's limit is reached.`,
    });
  }

  if (credits > perRun) {
    notices.push({
      id: "credit_cap",
      tone: "critical",
      blocking: true,
      action: "openSettings",
      message: `This run needs ${aiRequestCount(credits)}, over the limit of ${formatNumber(perRun)} per run in Settings > Translations. Pick fewer languages.`,
    });
  }

  if (check.charactersLeft < 0) {
    notices.push({
      id: "instructions",
      tone: "critical",
      blocking: true,
      message: `The extra instructions are ${plural(-check.charactersLeft, "character")} too long.`,
    });
  }

  return notices.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

export function isBlocked(notices: readonly Notice[]): boolean {
  return notices.some(({ blocking }) => blocking);
}

/** Translate starts with something ticked, every replacement of hand changes acknowledged, and no blocking banner. */
export function canStart(check: { credits: number; unacknowledged: number; notices: readonly Notice[] }): boolean {
  return check.credits > 0 && check.unacknowledged === 0 && !isBlocked(check.notices);
}

export function noticeLink(action: NoticeAction | undefined): { href: string; text: string } | undefined {
  return action === "openUsage" ? { href: SANITY_MANAGE_URL, text: "Open Sanity Manage" } : undefined;
}

/** "Translate", or "Translate 2 languages": the footer says what it costs. */
export function startLabel(languages: number): string {
  return languages > 1 ? `Translate ${languageCount(languages)}` : "Translate";
}

/** "About 130 words" under the languages, or what to do first: it says why Translate is disabled. */
export function summaryLine(words: number, credits: number, unacknowledged: readonly Pick<TargetOption, "name">[] = []): string {
  if (credits === 0) {
    return "Tick a language to translate.";
  }

  if (unacknowledged.length > 0) {
    return `Tick "I understand" for ${joinWords(unacknowledged.map(({ name }) => name))} to translate.`;
  }

  return sentenceCase(wordCountCopy(words));
}

/** The read-only view on a translation: what it is, its state, and where translations are made. */
export function translationNote(options: {
  language: string;
  status: TranslationStatus;
  sourceTitle: string;
  source: string;
  translatedAt?: string;
}): { heading: string; status: string; note: string } {
  return {
    heading: `This is the ${languageName(options.language)} translation of ${options.sourceTitle}.`,
    status: statusLine(statusText(options.status, { source: options.source, translatedAt: options.translatedAt })),
    note: `Translations are made from the ${options.source} page.`,
  };
}

export function savedResultCopy(saved: SavedResultSummary): string {
  const day = formatDay(saved.savedAt);

  return `A translation into ${languageName(saved.language)} was saved${day ? ` on ${day}` : ""} but not applied. Applying it is free and replaces that translation's current text.`;
}

export type NameRow = { language: string; title: string; value?: string; missing: boolean };

/** A category's name in each language: what it has, and what a run fills in. */
export function categoryNames(
  document: Record<string, unknown> | null | undefined,
  field: string,
  languages: readonly string[],
  label: Pick<LabelItem, "missing"> | undefined
): NameRow[] {
  const raw = document?.[field];
  const arms = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  return languages.map((language) => {
    const value = typeof arms[language] === "string" ? (arms[language] as string).trim() : "";

    return {
      language,
      title: getStudioLocaleTitle(language),
      ...(value ? { value } : {}),
      missing: label ? label.missing.includes(language) : value === "",
    };
  });
}

export type CategoryNoteOptions = {
  handFix?: LabelItem["handFix"];
  plain?: boolean;
  source?: string;
  /** A person: its role, bio and SEO fields translate in place, one call per language. */
  document?: boolean;
};

/** Under a category's names (a person's roles): what a run fills in, or why it sends nothing. */
export function categoryNote(rows: readonly Pick<NameRow, "missing">[], options: CategoryNoteOptions = {}): string {
  if (options.document) {
    return documentNote(rows, options);
  }

  if (options.plain) {
    return `This name is still plain text, not one per language. ${askDeveloperToRun("sanity:migrate-localize-fields")}`;
  }

  if (options.handFix) {
    return `${handFixText(options.handFix, options.source).hint} Fill the names in by hand.`;
  }

  return rows.some(({ missing }) => missing)
    ? "One AI request fills every name not translated yet. Names already set are never changed."
    : "Every language has a name already, so there is nothing to translate.";
}

function documentNote(rows: readonly Pick<NameRow, "missing">[], options: CategoryNoteOptions): string {
  if (options.plain) {
    return `These fields are still one value for every language. ${askDeveloperToRun("sanity:migrate-localize-fields")}`;
  }

  if (options.handFix) {
    return `${handFixText(options.handFix, options.source).hint} Fill the fields in by hand.`;
  }

  return rows.some(({ missing }) => missing)
    ? "One AI request per language fills the role, bio and SEO text not translated yet, then that language's agent Markdown. Text already set is never changed."
    : "Every language has its fields already, so there is nothing to translate.";
}

/** `site`: the document is part of a whole-site run, which Stop ends for every document. */
export function stopLabel(running: number, stopping: boolean, options: { site?: boolean } = {}): string {
  if (stopping) {
    return "Stopping...";
  }

  const stop = options.site ? "Stop the site run" : "Stop";

  return running > 0 ? `${stop} after the ${formatNumber(running)} running` : stop;
}

export function rateLimitCopy(ms: number): string {
  return `Sanity is rate limiting AI requests. Retrying in ${formatDuration(ms)}.`;
}

/** This document's jobs in the tab's run: all of its own run's, or its share of a whole-site run. */
export function coveredJobs(run: TranslationRun | null | undefined, documentId: string): RunJob[] {
  if (!run) {
    return [];
  }

  if (run.scope.kind === "document" && run.scope.sourceId === documentId) {
    return run.jobs;
  }

  return run.jobs.filter(
    (job) =>
      (job.kind === "pair" && job.sourceId === documentId) ||
      (job.kind === "labels" && (job.input.ids ?? []).includes(documentId))
  );
}

/** The action's "Translating... 1 of 2": this document's translations in the tab's run (not Update links), or null. */
export function documentProgress(
  run: TranslationRun | null | undefined,
  documentId: string
): { total: number; finished: number; active: boolean } | null {
  const jobs = coveredJobs(run, documentId).filter((job) => job.kind !== "relink");

  if (!run || jobs.length === 0) {
    return null;
  }

  const finished = jobs.filter(({ state }) => state !== "queued" && state !== "running").length;

  return { total: jobs.length, finished, active: isRunActive(run) && finished < jobs.length };
}

/** What a document's done view sums up: a whole-site run narrowed to its own jobs. */
export function documentRun(run: TranslationRun | null | undefined, documentId: string): TranslationRun | null {
  const jobs = coveredJobs(run, documentId);

  if (!run || jobs.length === 0) {
    return null;
  }

  return run.scope.kind === "site" ? { ...run, jobs } : run;
}

/** A job's name on screen: the language with its flag, or the category name. */
export function jobName(job: RunJob): string {
  return job.kind === "pair" ? getStudioLocaleTitle(job.language) : job.title;
}

/** The same, in a sentence: "Italian". */
export function spokenName(job: RunJob): string {
  return job.kind === "pair" ? languageName(job.language) : job.title;
}

export type JobIcon = "waiting" | "running" | "done" | "skipped" | "failed" | "saved" | "stopped";

export type JobLine = { icon: JobIcon; label: string; detail?: string; elapsed?: string };

function doneLabel(job: RunJob): string {
  if (job.kind === "labels") {
    return "Category names saved";
  }

  if (job.kind === "relink") {
    return "Links updated";
  }

  if (job.result?.published) {
    return "Published";
  }

  return "Draft saved";
}

function runningLabel(job: RunJob): string {
  switch (job.kind) {
    case "labels":
      return "Translating category names with Sanity AI";
    case "relink":
      return "Updating links on other pages";
    case "pair":
      return "Translating with Sanity AI";
  }
}

function doneDetail(job: RunJob): string | undefined {
  if (job.message) {
    return job.message;
  }

  return job.kind === "relink" && job.result ? linksCopy(job.result, job.input.publish === true) : undefined;
}

/** One row of the running view; `now` drives the timer, which stays out of the live region. */
export function jobLine(job: RunJob, now: number): JobLine {
  const elapsed =
    job.startedAt === undefined ? undefined : formatDuration((job.finishedAt ?? Math.max(now, job.startedAt)) - job.startedAt);

  switch (job.state) {
    case "queued":
      if (job.retries.rateLimited > 0) {
        return { icon: "waiting", label: "Waiting: Sanity is rate limiting AI requests" };
      }

      if (job.retries.outOfTime > 0) {
        return { icon: "waiting", label: "Waiting: asking again with a fresh request" };
      }

      if (job.retries.busy > 0) {
        return { icon: "waiting", label: "Waiting: another request is translating this language" };
      }

      return { icon: "waiting", label: "Waiting" };
    case "running":
      return { icon: "running", label: runningLabel(job), ...(elapsed ? { elapsed } : {}) };
    case "done": {
      const detail = doneDetail(job);

      return { icon: "done", label: doneLabel(job), ...(elapsed ? { elapsed } : {}), ...(detail ? { detail } : {}) };
    }
    case "skipped":
      return { icon: "skipped", label: "Skipped", ...(job.message ? { detail: job.message } : {}) };
    case "failed":
      return { icon: "failed", label: "Failed", ...(job.message ? { detail: job.message } : {}) };
    case "saved_result":
      return { icon: "saved", label: "Saved, not applied", ...(job.message ? { detail: job.message } : {}) };
    case "stopped":
      return { icon: "stopped", label: "Not started" };
  }
}

export type RunOutcome = { tone: "positive" | "caution" | "critical"; title: string; description: string };

function paidJobs(run: TranslationRun): (PairJob | LabelsJob)[] {
  return run.jobs.filter((job): job is PairJob | LabelsJob => job.kind === "pair" || job.kind === "labels");
}

/** The done view's AI request total, in the footer where the configure view shows the word count. */
export function requestTotalCopy(run: TranslationRun): string {
  return sentenceCase(requestsMadeCopy(runTotals(run)));
}

/** Drafts this run saved and nothing published: other pages keep linking to the source until they are. */
function savedDrafts(jobs: readonly RunJob[]): number {
  return jobs.filter((job) => job.kind === "pair" && job.state === "done" && job.result?.published !== true).length;
}

/** What the toast adds about links: they follow a published translation only through Update links. */
function linksNote(run: TranslationRun): string | undefined {
  const links = run.jobs.find((job) => job.kind === "relink");

  if (links && (links.state === "failed" || links.state === "stopped")) {
    return `Links were not updated: use ${UPDATE_LINKS} in Settings > Translations.`;
  }

  const drafts = savedDrafts(run.jobs);

  if (links || drafts === 0) {
    return undefined;
  }

  return `Once ${drafts === 1 ? "it is" : "they are"} published, use ${UPDATE_LINKS} in Settings > Translations so other pages link to ${drafts === 1 ? "it" : "them"}.`;
}

/** The final toast and the live region's last word. */
export function runOutcome(run: TranslationRun): RunOutcome {
  const jobs = paidJobs(run);
  const count = (state: RunJob["state"]) => jobs.filter((job) => job.state === state).length;
  const done = jobs.filter((job) => job.state === "done");
  const failed = count("failed");
  const saved = count("saved_result");
  const skipped = count("skipped");
  const notStarted = count("stopped");
  const parts = [
    `${formatNumber(done.length)} translated`,
    `${formatNumber(failed)} failed`,
    ...(saved > 0 ? [`${formatNumber(saved)} saved to apply for free`] : []),
    ...(skipped > 0 ? [`${formatNumber(skipped)} skipped`] : []),
    ...(notStarted > 0 ? [`${formatNumber(notStarted)} not started`] : []),
  ];
  const note = linksNote(run);
  const description = `${[...parts, requestsMadeCopy(runTotals(run))].join(", ")}.${note ? ` ${note}` : ""}`;
  const stop = run.stopReason;

  if (stop && stop.code !== "stopped") {
    return { tone: "critical", title: "Translation stopped", description: `${stop.message} ${description}` };
  }

  if (stop) {
    return { tone: "caution", title: "Translation stopped", description };
  }

  if (failed > 0 || saved > 0) {
    return { tone: "caution", title: "Translation finished with problems", description };
  }

  if (done.length === 0) {
    return { tone: "positive", title: "Nothing needed translating", description };
  }

  const languages = done.flatMap((job) => (job.kind === "pair" ? [languageName(job.language)] : []));
  const title = languages.length > 0 ? `Translated into ${joinWords(languages)}` : "Category name translated";

  return { tone: "positive", title, description };
}

export function toastStatus(tone: RunOutcome["tone"]): "success" | "warning" | "error" {
  if (tone === "positive") {
    return "success";
  }

  return tone === "caution" ? "warning" : "error";
}

/** The `aria-live` text: what finished, never the timer. */
export function runAnnouncement(run: TranslationRun | null | undefined): string {
  if (!run) {
    return "";
  }

  if (run.status === "done" || run.status === "stopped") {
    const outcome = runOutcome(run);

    return `${outcome.title}. ${outcome.description}`;
  }

  const totals = runTotals(run);
  const latest = run.jobs
    .filter((job) => job.finishedAt !== undefined)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  const last = latest ? ` ${spokenName(latest)}: ${jobLine(latest, latest.finishedAt ?? 0).label}.` : "";
  const stopping = run.status === "stopping" ? " Stopping after the running request." : "";

  return `${formatNumber(totals.finished)} of ${formatNumber(totals.total)} done.${last}${stopping}`;
}

/** Under the running view: the dialog may close, but the queue lives in this tab. */
export function runningNote(isPartOfSiteRun: boolean): string {
  const keep = "You can close this dialog. Keep this browser tab open until the run ends.";

  return isPartOfSiteRun
    ? `This document is part of the whole-site run from Settings > Translations. ${keep}`
    : `${keep} The Translate with AI button shows its progress.`;
}

export type PairOutcome = {
  id: string;
  sourceId: string;
  language: string;
  /** The flag and native title. */
  title: string;
  /** "🇮🇹 Italiano: translated, saved as draft". */
  line: string;
  message?: string;
  uri?: string;
  targetId?: string;
  canApply: boolean;
  /** "6 texts came back in English, check them before publishing.": only then is there a Details disclosure. */
  keptNote?: string;
  keptPaths: string[];
  guardedPaths: string[];
  action?: NoticeAction;
};

function outcomeWords(job: PairJob, recovered: boolean): string {
  if (recovered) {
    return "translated, not applied yet";
  }

  switch (job.state) {
    case "done":
      return job.result?.published ? "translated and published" : "translated, saved as draft";
    case "saved_result":
      return "translated, not applied yet";
    case "skipped":
      return "skipped";
    case "failed":
      return "failed";
    case "stopped":
      return "not started";
    case "queued":
      return "waiting";
    case "running":
      return "translating";
  }
}

/** Where a stop or a failure sends the editor: the spending limit and AI usage live in Sanity Manage, the rest in Settings. */
export function noticeActionFor(code: string | undefined): NoticeAction | undefined {
  if (code === "budget_exceeded" || code === "rate_limited") {
    return "openUsage";
  }

  return code === "daily_cap" ? "openSettings" : undefined;
}

/** One language in the done view; `saved`: a fresh plan lists a saved result for it, as after a lost answer. */
export function pairOutcome(job: PairJob, source: string, options: { saved?: boolean } = {}): PairOutcome {
  const result = job.result;
  const kept = result?.keptPaths ?? [];
  const keptCount = job.state === "done" ? (result?.stats?.keptInEnglish ?? kept.length) : 0;
  const recovered = options.saved === true && job.state === "failed";
  const message = recovered ? "The answer was lost, but the paid result was saved. Apply it for free." : job.message;
  const action = job.state === "failed" ? noticeActionFor(job.code) : undefined;
  const title = getStudioLocaleTitle(job.language);

  return {
    id: job.id,
    sourceId: job.sourceId,
    language: job.language,
    title,
    line: `${title}: ${outcomeWords(job, recovered)}`,
    ...(job.state !== "done" && message ? { message } : {}),
    ...(result?.uri ? { uri: result.uri } : {}),
    ...(result?.targetId ? { targetId: result.targetId } : {}),
    // Apply refuses it too: linking that language's own document is the fix.
    canApply: (job.state === "saved_result" && job.code !== "unlinked_translation") || recovered,
    ...(keptCount > 0 ? { keptNote: `${plural(keptCount, "text")} came back in ${source}, check them before publishing.` } : {}),
    keptPaths: kept,
    guardedPaths: result?.guardedPaths ?? [],
    ...(action ? { action } : {}),
  };
}

/** The done view's heading for a job that is not a language: a category run's names, or Update links. */
export function otherJobHeading(job: LabelsJob | RelinkJob): string {
  if (job.kind === "labels") {
    return jobLine(job, job.finishedAt ?? 0).label;
  }

  switch (job.state) {
    case "done":
      return "Links updated";
    case "failed":
      return "Links not updated";
    case "stopped":
      return "Links not updated: the run stopped first";
    default:
      return jobLine(job, 0).label;
  }
}

/** A category run's names, as written. */
export function labelsOutcome(job: LabelsJob, id: string): NameRow[] {
  const names = job.result?.labels?.[id] ?? {};

  return Object.entries(names).map(([language, value]) => ({
    language,
    title: getStudioLocaleTitle(language),
    value,
    missing: false,
  }));
}

/** Only after drafts: a published translation needs nothing more from the editor, since the run updated the links. */
export function nextStep(jobs: readonly RunJob[], source = "English"): string | undefined {
  const drafts = savedDrafts(jobs);

  if (drafts === 0) {
    return undefined;
  }

  return drafts === 1
    ? `Review the draft, then publish it. Then use ${UPDATE_LINKS}, so other pages link to it instead of the ${source} page.`
    : `Review the drafts, then publish them. Then use ${UPDATE_LINKS}, so other pages link to them instead of the ${source} pages.`;
}

/** Apply over a translation changed by hand since the result was paid for replaces that work, so the route asks first. */
export function applyWarning(
  row: Pick<PlanRow, "targets"> | undefined,
  language: string,
  options: { forced?: boolean } = {}
): ReplaceWarning | undefined {
  const status = row?.targets.find((target) => target.language === language)?.status;

  if (!options.forced && !(status && requiresOverwrite(status))) {
    return undefined;
  }

  const name = languageName(language);

  return {
    message: `Applying replaces the ${name} page with this saved translation. Changes made in ${name} since are lost. Its URL, Password protect and No Index stay as they are.`,
    acknowledgement: `I understand the ${name} changes are replaced`,
  };
}

/** "Link as the Italian translation": the fix for a document already where the translation goes. */
export function linkLabel(language: string): string {
  return `Link as the ${languageName(language)} translation`;
}

/** The confirm before linking: the document's own title, so the editor can tell it is the same page or person. */
export function linkConfirmCopy(options: { title?: string; language: string; sourceTitle: string; step: RunStep }): string {
  const name = languageName(options.language);
  const what = options.title ? `“${options.title}”` : `this ${name} document`;
  const person =
    options.step === "person" ? " If this is someone else with the same slug, change one of the slugs instead of linking." : "";

  return `Link ${what} as the ${name} translation of “${options.sourceTitle}”? It joins the translation group as it is: nothing is translated or published, and no AI request is made.${person}`;
}

export type DialogView = "running" | "done" | "loading" | "failed" | "translation" | "unavailable" | "configure";

export type DialogViewState = {
  /** This document's jobs in the tab's run: going, or finished and not yet seen. */
  run: "running" | "done" | null;
  plan: "loading" | "failed" | "ready";
  /** A plan is on screen, the last one included while a refresh loads. */
  hasPlan: boolean;
  subject: DialogSubject["kind"] | null;
};

/** Which of the dialog's seven views shows: a run first, then the plan's answer about this document. */
export function dialogView(state: DialogViewState): DialogView {
  if (state.run) {
    return state.run;
  }

  if (state.plan === "loading" && !state.hasPlan) {
    return "loading";
  }

  if (state.plan === "failed") {
    return "failed";
  }

  if (state.subject === "translation") {
    return "translation";
  }

  if (!state.hasPlan || state.subject === null || state.subject === "unlinked" || state.subject === "missingLanguage") {
    return "unavailable";
  }

  return "configure";
}

/** Answers the same way however often it is asked, so a failed plan offers no Try again. */
const FINAL_PLAN_CODES: ReadonlySet<string> = new Set(["forbidden", "unauthorized", "off", "i18n_disabled"]);

export function canRetryPlan(code: string): boolean {
  return !FINAL_PLAN_CODES.has(code);
}

/** Why there is nothing to translate from this document: no language yet, or no source it is linked to. */
export function unavailableCopy(kind: "missingLanguage" | "unlinked" | "none", source: string): string {
  if (kind === "missingLanguage") {
    return TRANSLATE_MESSAGES.missing_language;
  }

  return `This document is not linked to ${withArticle(source)} page, so there is nothing to translate it from. To make it a translation, open Translate with AI on the ${source} page: it offers to link a document already where the translation goes. For any other, ask a developer to link them.`;
}

export type ToastCopy = { status: "success" | "warning" | "error"; title: string; description?: string };

/** `name` is the language in prose ("Italian"), or the panel's "About (Italiano)". */
export function applyAnswer(
  answer: ApiResult<PairResult>,
  name: string
): { outcome: "applied" | "needsOverwrite" | "failed"; toast: ToastCopy } {
  if (answer.ok && answer.data.status === "translated") {
    return {
      outcome: "applied",
      toast: {
        status: "success",
        title: `Applied the ${name} translation`,
        description: answer.data.published ? "It is published." : "It is saved as a draft for you to review and publish.",
      },
    };
  }

  const code = answer.ok ? answer.data.code : answer.error.code;
  const description = answer.ok ? (answer.data.error ?? answer.data.message) : answer.error.message;

  return {
    outcome: code === "needs_overwrite" ? "needsOverwrite" : "failed",
    toast: { status: code === "needs_overwrite" ? "warning" : "error", title: "Saved result not applied", description },
  };
}

export function discardAnswer(answer: ApiResult<DiscardResult>, name: string): { ok: boolean; toast: ToastCopy } {
  if (answer.ok && answer.data.status === "discarded") {
    return {
      ok: true,
      toast: { status: "success", title: "Saved result discarded", description: `Nothing offers the ${name} result again.` },
    };
  }

  const description = answer.ok ? (answer.data.error ?? answer.data.message ?? TRANSLATE_MESSAGES.busy) : answer.error.message;

  return { ok: false, toast: { status: "error", title: "Saved result not discarded", description } };
}

/** A link answer: the preview's title to confirm, a done link, or why it was refused. */
export function linkAnswer(
  answer: ApiResult<LinkResult>
): { status: "preview" | "linked"; title?: string } | { status: "failed"; message: string } {
  if (answer.ok && (answer.data.status === "preview" || answer.data.status === "linked")) {
    return { status: answer.data.status, ...(answer.data.title ? { title: answer.data.title } : {}) };
  }

  const message = answer.ok ? (answer.data.error ?? answer.data.message ?? TRANSLATE_MESSAGES.busy) : answer.error.message;

  return { status: "failed", message };
}

export function linkedToast(language: string): ToastCopy {
  const name = languageName(language);

  return {
    status: "success",
    title: `Linked as the ${name} translation`,
    description: `It is now the ${name} translation, as it is. Translate it with AI only if you want the AI's version instead.`,
  };
}

export function updateLinksToast(answer: ApiResult<RelinkResult>): ToastCopy {
  return answer.ok
    ? { status: "success", title: "Links updated", description: linksCopy(answer.data, true) }
    : { status: "error", title: "Links were not updated", description: answer.error.message };
}

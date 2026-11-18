// Editor-facing words for Translate with AI, shared by the document action and the Settings panel: statuses, AI
// requests, durations, what a translation keeps. Pure, so the copy is tested without rendering.

import type { BadgeTone } from "@sanity/ui";
import { AI_TRANSLATION_FIELD, TRANSLATION_EXCLUDED_FIELDS } from "../constants";
import { getLocaleTitle } from "../i18n";
import { countWords, translatableLeaves } from "./fields";
import type { LabelItem, TargetHold, TranslationStatus } from "./plan";
import type { JobState, RunTotals } from "./run-store";
import type { BulkPolicy } from "./style-guide";
import type { CreditsToday, RelinkResult } from "./wire";

/** Kept out of buttons and footers: More options and the whole-site confirm say it once. Sanity sets the terms. */
export const AI_USAGE_NOTE = "Uses your Sanity organization's AI credits. Check usage in your organization settings.";

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/** "Italian": a language as English prose names it. Labels keep the flag and native title. */
export function languageName(id: string): string {
  try {
    return LANGUAGE_NAMES.of(id) ?? getLocaleTitle(id);
  } catch {
    return getLocaleTitle(id);
  }
}

// en-GB writes September "Sept"; every other month has three letters either way.
const SHORT_MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });

/** "20 Oct 2026": the Studio's copy is English. */
export function formatDay(iso: string | undefined): string | undefined {
  const date = iso ? new Date(iso) : undefined;

  if (!date || Number.isNaN(date.getTime())) {
    return undefined;
  }

  return `${date.getDate()} ${SHORT_MONTH.format(date)} ${date.getFullYear()}`;
}

/** A translation's state as a fact, never a verdict: two languages may differ on purpose. */
export type StatusText = { text: string; hint?: string };

/** `source` names the default language in prose ("English"); `translatedAt` is the record's date, when it was read. */
export function statusText(status: TranslationStatus, options: { source?: string; translatedAt?: string } = {}): StatusText {
  const source = options.source ?? "English";
  const day = formatDay(options.translatedAt);
  const byAi = day ? `Translated by AI on ${day}` : "Translated by AI";

  switch (status) {
    case "notTranslated":
      return { text: "Not translated yet" };
    case "copyOfEnglish":
      return { text: `Still in ${source}`, hint: `The page exists but holds the ${source} text.` };
    case "upToDate":
      return { text: byAi };
    case "englishChanged":
    case "layoutChanged":
      return { text: byAi, hint: `${source} updated since.` };
    case "editedByHand":
      return { text: "Edited since the AI translation" };
    case "translatedByHand":
      return { text: "Written by hand" };
  }
}

/** The language already has its own document where the translation would go: link it instead. */
export function unlinkedText(source = "English"): StatusText {
  return {
    text: "Not linked",
    hint: `This language already has its own version, not linked as its translation. Link it with Translate with AI on the ${source} page instead of translating.`,
  };
}

const HOLD_HINTS: Readonly<Record<Exclude<TargetHold, "inRelease">, string>> = {
  twoGroups: "This page sits in two translation groups, so whole-site runs leave it out. The oldest group is used.",
  timedOut:
    "The last try ran out of time on this text and may still count toward your AI usage, so whole-site runs leave it out. Trying again makes another AI request and may run out of time again.",
};

/** A target held out of whole-site runs (`PlanTarget.hold`): its status words, and why. */
export function heldText(hold: TargetHold, status: StatusText): StatusText {
  if (hold === "inRelease") {
    return {
      text: "In a release",
      hint: "Its translation exists only inside a release. Publish or discard that release version, then translate.",
    };
  }

  return { text: status.text, hint: [status.hint, HOLD_HINTS[hold]].filter(Boolean).join(" ") };
}

/** A translation draft the AI wrote that nobody published yet: the site still serves the published copy, or nothing. */
export const DRAFT_HINT = "Draft, not published.";

/** Fixed copy for a Contributor, in the action's tooltip and when the route answers 403. */
export const PUBLISH_ACCESS_TEXT = "Only people who can publish can translate with AI.";

/** "Ask a developer to run npm run X.": an editor never runs a command, so copy says who does. */
export function askDeveloperToRun(script: string): string {
  return `Ask a developer to run npm run ${script}.`;
}

/** A category name never sent: the source name fails the checks, or the AI's answer failed them or left it out twice. */
export function handFixText(handFix: NonNullable<LabelItem["handFix"]>, source = "English"): StatusText {
  const hint =
    handFix === "sourceFailsChecks"
      ? `The ${source} name is too long or holds markup, so it is never sent to the AI.`
      : `The AI's answer for it failed the checks, or left it out twice in a row, so it is not asked again until the ${source} name changes.`;

  return { text: "Fill in by hand", hint };
}

/** The text and its hint on one line, where there is room for only one. */
export function statusLine({ text, hint }: StatusText): string {
  return hint ? `${text}. ${hint}` : text;
}

/** Each translation's `translatedAt` by published id, the draft's first: the copy the plan reads a status from. */
export function translatedAtById(rows: readonly { _id: string; at?: unknown }[]): Record<string, string> {
  const dates: Record<string, string> = {};

  for (const { _id, at } of rows) {
    if (typeof at !== "string") {
      continue;
    }

    const isDraft = _id.startsWith("drafts.");
    const id = isDraft ? _id.slice("drafts.".length) : _id;

    if (isDraft || dates[id] === undefined) {
      dates[id] = at;
    }
  }

  return dates;
}

/** Settings' `policy` options; the panel's refresh checkbox reads the second. */
export function policyTitles(source: string): Record<BulkPolicy, string> {
  return {
    missing: "Only pages not translated yet",
    refresh: `Also refresh AI translations whose ${source} was updated`,
  };
}

export type Presentation = { label: string; tone: BadgeTone };

export function jobStatePresentation(state: JobState): Presentation {
  switch (state) {
    case "queued":
      return { label: "Waiting", tone: "default" };
    case "running":
      return { label: "Translating", tone: "primary" };
    case "done":
      return { label: "Done", tone: "positive" };
    case "skipped":
      return { label: "Skipped", tone: "default" };
    case "failed":
      return { label: "Failed", tone: "critical" };
    case "saved_result":
      return { label: "Saved, not applied", tone: "caution" };
    case "stopped":
      return { label: "Not started", tone: "default" };
  }
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en");
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatNumber(count)} ${count === 1 ? one : many}`;
}

/** The app's own count of the calls it makes to Sanity AI: "1 AI request". Never a price or a credit figure. */
export function aiRequestCount(requests: number): string {
  return plural(requests, "AI request");
}

export function requestsTodayCopy({ used, max }: Pick<CreditsToday, "used" | "max">): string {
  return `AI requests today: ${formatNumber(used)} of ${formatNumber(max)}`;
}

/** "3 AI requests made, 1 more may still count": a lost answer is counted as maybe, in every view. */
export function requestsMadeCopy({
  creditsSpent,
  creditsMaybeSpent,
}: Pick<RunTotals, "creditsSpent" | "creditsMaybeSpent">): string {
  if (creditsSpent === 0 && creditsMaybeSpent === 0) {
    return "no AI requests made";
  }

  const maybe = creditsMaybeSpent > 0 ? `, ${formatNumber(creditsMaybeSpent)} more may still count` : "";

  return `${aiRequestCount(creditsSpent)} made${maybe}`;
}

/** The progress line under a run's bar, in the dialog and the panel; it changes only when a job finishes. */
export function runProgressCopy(totals: Pick<RunTotals, "finished" | "total" | "creditsSpent" | "creditsMaybeSpent">): string {
  return `${formatNumber(totals.finished)} of ${formatNumber(totals.total)} done, ${requestsMadeCopy(totals)}`;
}

/** What Update links does, wherever it is offered: free, and it publishes. */
export const UPDATE_LINKS_NOTE =
  "Free. Points the links on other pages at the translations published since, and publishes the pages it changes. An open draft only gets the new links.";

/** An Update links pass, summed up for a toast or a run's row. */
export function linksCopy(result: RelinkResult, publish = true): string {
  const updated = result.relinked.length;
  const published = result.published.length;
  const failed = result.failed?.length ?? 0;
  const parts = [
    ...(updated > 0
      ? [
          `${plural(updated, "translation")} now ${updated === 1 ? "links to pages in its" : "link to pages in their"} own language`,
        ]
      : []),
    ...(publish && published > 0 ? [`${plural(published, "page")} published`] : []),
    ...(!publish && updated > 0 ? ["saved as drafts: publish them to make the links live"] : []),
    ...(result.conflicts.length > 0 ? [`${formatNumber(result.conflicts.length)} changed meanwhile and were left alone`] : []),
    ...(failed > 0 ? [`${formatNumber(failed)} could not be saved`] : []),
    ...(result.remaining > 0 ? [`${formatNumber(result.remaining)} still to do`] : []),
  ];
  const again = result.remaining > 0 || failed > 0 ? ": update links again" : "";

  return parts.length > 0 ? `${sentence(parts.join(", "))}${again}.` : "Every link already points at the right language.";
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `0:09`, `1:12`, `1:02:03`: a timer, so it never shows a fraction. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");

  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

export function formatTimeLeft(ms: number): string {
  const minutes = Math.round(ms / 60_000);

  if (minutes < 1) {
    return "less than a minute left";
  }

  return `about ${plural(minutes, "min", "min")} left`;
}

/** "a, b and c". */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "seoMetadata" reads "Seo metadata": what a field without a schema title is called. */
export function humanizeFieldName(name: string): string {
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type FieldTitles = Readonly<Record<string, string>>;

/** Top-level field titles from a Studio schema type (`schema.get(type)`); only its shape is read. */
export function fieldTitlesOf(
  schemaType: { fields?: readonly { name: string; type?: { title?: string } }[] } | null | undefined
): Record<string, string> {
  return Object.fromEntries(
    (schemaType?.fields ?? []).flatMap(({ name, type }) => (type?.title ? [[name, type.title] as const] : []))
  );
}

function titleOf(name: string, titles: FieldTitles | undefined): string {
  return titles?.[name] ?? humanizeFieldName(name);
}

export type TranslatableField = {
  name: string;
  title: string;
  /** Strings and rich text blocks; a block counts once. */
  texts: number;
  words: number;
  /** For a list (page builder sections, a gallery): how many of its items hold text. */
  items?: number;
};

export type TranslatableSummary = { fields: TranslatableField[]; texts: number; words: number };

/** "What the AI translates": the same walk the merge guard runs, grouped by top-level field in document order. */
export function translatableSummary(document: Record<string, unknown>, titles?: FieldTitles): TranslatableSummary {
  const leaves = translatableLeaves(document);
  const fields = new Map<string, { leaves: typeof leaves; items: Set<string> }>();

  for (const leaf of leaves) {
    const [name, item] = leaf.path;

    if (typeof name !== "string") {
      continue;
    }

    const entry = fields.get(name) ?? { leaves: [], items: new Set<string>() };

    entry.leaves.push(leaf);

    if (Array.isArray(document[name]) && item !== undefined) {
      entry.items.add(typeof item === "object" ? item._key : String(item));
    }

    fields.set(name, entry);
  }

  return {
    fields: [...fields].map(([name, entry]) => ({
      name,
      title: titleOf(name, titles),
      texts: entry.leaves.length,
      words: countWords(entry.leaves),
      ...(Array.isArray(document[name]) ? { items: entry.items.size } : {}),
    })),
    texts: leaves.length,
    words: countWords(leaves),
  };
}

export function wordCountCopy(words: number): string {
  if (words === 0) {
    return "No text to translate";
  }

  return words < 10 ? plural(words, "word") : `about ${plural(Math.round(words / 10) * 10, "word")}`;
}

/** The fields Translate never sees, in words: set by the write, or kept as the source has them. */
const FIELD_WORDS: Readonly<Record<string, string>> = {
  agentMarkdown: "agent Markdown",
};

/** What every translation keeps from the source, whatever the AI answers: the merge guard's rules in plain words. */
export const KEPT_AS_THEY_ARE: readonly string[] = [
  "an existing translation's URL and its Password protect and No Index switches",
  "links and references",
  "images and media",
  "settings (layout, colors, switches)",
  "people's names and protected phrases",
];

/** "Kept as they are" and "Not copied" for the configure state. */
export function keptAsTheyAre(): { kept: readonly string[]; notCopied: string[] } {
  return {
    kept: KEPT_AS_THEY_ARE,
    notCopied: TRANSLATION_EXCLUDED_FIELDS.filter((field) => field !== AI_TRANSLATION_FIELD).map(
      (field) => FIELD_WORDS[field] ?? humanizeFieldName(field).toLowerCase()
    ),
  };
}

type Segment = string | number | { _key: string };

/** The route's patch paths (`sections[_key=="a"].heading`) back into segments. */
export function parsePatchPath(path: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = /([A-Za-z_]\w*)|\[_key=="((?:[^"\\]|\\.)*)"\]|\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]/g;

  for (const match of path.matchAll(pattern)) {
    const [, name, key, index, quoted] = match;

    if (name !== undefined) {
      segments.push(name);
    } else if (key !== undefined) {
      segments.push({ _key: key.replace(/\\(.)/g, "$1") });
    } else if (index !== undefined) {
      segments.push(Number(index));
    } else if (quoted !== undefined) {
      segments.push(quoted.replace(/\\(.)/g, "$1"));
    }
  }

  return segments;
}

/** Path keys that are not field names an editor knows. */
const PATH_WORDS: Readonly<Record<string, string>> = {
  markDefs: "link",
  href: "link",
  _ref: "reference",
  _type: "type",
  _key: "key",
  uri: "URL slug",
};

function typeOf(value: unknown): unknown {
  return typeof value === "object" && value !== null ? (value as { _type?: unknown })._type : undefined;
}

function childOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A guarded or kept path in words, items numbered from 1 when `document` (the source) is at hand. */
export function describePath(path: string, document?: Record<string, unknown>, titles?: FieldTitles): string {
  const words: string[] = [];
  let value: unknown = document;

  parsePatchPath(path).forEach((segment, index) => {
    if (typeof segment === "string") {
      const known = PATH_WORDS[segment];
      const word =
        index === 0
          ? (titles?.[segment] ?? (known ? known.charAt(0).toUpperCase() + known.slice(1) : humanizeFieldName(segment)))
          : (known ?? humanizeFieldName(segment).toLowerCase());

      // A span is part of its paragraph, and `current` is the inside of a slug: naming either adds noise.
      if (segment !== "children" && segment !== "current") {
        words.push(word);
      }

      value = childOf(value, segment);

      return;
    }

    const list = Array.isArray(value) ? value : [];
    const position =
      typeof segment === "number"
        ? segment
        : list.findIndex((item) => (item as { _key?: unknown } | null)?._key === segment._key);

    value = position >= 0 ? list[position] : undefined;

    if (typeOf(value) === "span") {
      return;
    }

    words.push(position >= 0 ? `${typeOf(value) === "block" ? "paragraph" : "item"} ${position + 1}` : "an item");
  });

  return words.join(", ");
}

/** De-duplicated, in order, at most `limit`, with "and N more" so the list stays readable. */
export function describePaths(
  paths: readonly string[],
  document?: Record<string, unknown>,
  titles?: FieldTitles,
  limit = 10
): string[] {
  const described = [...new Set(paths.map((path) => describePath(path, document, titles)))];

  return described.length > limit
    ? [...described.slice(0, limit), `and ${formatNumber(described.length - limit)} more`]
    : described;
}

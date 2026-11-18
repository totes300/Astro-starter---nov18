// The translate route's contract, shared by the route and the Studio: request and answer shapes, codes, fixed copy.
// The route and every code: docs/features/ai-translation.md

import type { AgentErrorCode } from "./agent-errors";
import type { MergeStats } from "./merge";
import type { TranslationPlan, TranslationStatus } from "./plan";
import type { BulkPolicy, TranslationLanguage, TranslationSettings } from "./style-guide";

/** Fixed copy: nothing upstream, and no document text, ever reaches the Studio. */
export const TRANSLATE_MESSAGES = {
  busy: "This document is already being translated into this language. Try again in a moment.",
  skipped: "This translation changed since the plan was read, so it was left as it is. No AI request was made.",
  aborted: "Stopped before the AI call.",
  conflict:
    "The translation changed while the AI was working, so nothing was overwritten. Apply the saved result (free) to use it anyway.",
  write_failed: "The translation could not be saved. Apply the saved result (free) to try again.",
  saved_result_exists: "This language already has a saved AI result. Apply it for free instead.",
  lost: "The translation could not be saved, and the paid result could not be kept either.",
  source_not_found: "The source document was not found. Publish it, or translate its unpublished changes.",
  not_a_source: "Translate from the default language's document.",
  missing_language:
    "This document has no language yet, so it cannot be translated. Ask a developer to run npm run sanity:migrate-backfill-language.",
  daily_cap: "Today's AI request limit from Settings > Translations is reached.",
  schema_drift:
    "The deployed schema differs from this code. Ask a developer to run npm run sanity:schema-deploy, then try again.",
  wrong_target_language:
    "The translation group links a document in another language for this one. Fix the group in the Studio, then try again.",
  no_saved_result: "There is no saved result for this translation.",
  invalid_labels: "Sanity AI answered with translations that did not pass the checks, so nothing was written.",
  labels_left_for_hand:
    "Some category names or people did not pass the checks and were left out. Fill them in by hand, or change the English and run again.",
  nothing_missing: "Every category name and person already has these languages.",
  out_of_time: "This request ran short of time before the AI call, so nothing was spent. Try again.",
  unlinked_translation:
    "This language already has its own version of this document, not linked as its translation. Link it as the translation instead of translating again.",
  in_release:
    "This language's translation exists only inside a release, so it was left as it is. Publish or discard that release version, then try again.",
  needs_overwrite:
    "Someone changed this translation since the AI wrote this result. Applying it replaces their changes, so confirm the overwrite first.",
  link_not_found: "The document to link was not found.",
  link_mismatch: "Only a document of the same type, written in this language, can be linked as its translation.",
  link_taken: "That document is already linked in a translation group, or this language already has a linked translation.",
  sanity_unavailable: "Sanity could not be read or written before the AI call, so nothing was spent. Try again in a moment.",
  off: "Translate with AI is switched off: the AI request limit per day in Settings > Translations is 0.",
  two_groups:
    "This document sits in two translation groups, so a new translation could duplicate one in the other group. Ask a developer to merge them, then try again.",
} as const;

export type TranslateCode = keyof typeof TRANSLATE_MESSAGES | AgentErrorCode | "bad_input" | "style_guide_too_long";

/** What the route's gate and its error wrapper answer with, around any action. */
export type RouteErrorCode = "unauthorized" | "forbidden" | "auth_unavailable" | "i18n_disabled" | "internal_error";

export type PlanRequest = {
  /** One document's plan (the source or any translation of it); unset reads the whole site. */
  documentId?: string;
  useDraft?: boolean;
  languages?: string[];
  policy?: BulkPolicy;
};

export type SchemaCheck = { deployedAt: string | null; drift: string[] };

export type PlanBlock = { code: "schema_drift"; message: string };

export type CreditsToday = { day: string; used: number; max: number };

export type SavedResultSummary = { sourceId: string; language: string; savedAt: string };

export type PlanResponse = {
  defaultLocale: string;
  locales: TranslationLanguage[];
  settings: {
    defaults: TranslationSettings["defaults"];
    styleGuideLength: number;
    /** Per target language: the compiled guide before a run's own instructions, which share its 2,000 characters. */
    styleGuideByLanguage: Record<string, number>;
    protectedPhrases: number;
    glossaryTerms: number;
    languageNotes: string[];
  };
  plan: TranslationPlan;
  creditsToday: CreditsToday;
  schema: SchemaCheck & { ok: boolean };
  /** Why a run would be refused now. */
  blocked: PlanBlock | null;
  /** Paid results not yet written: "Apply saved result (free)". */
  savedResults: SavedResultSummary[];
};

export type PairInput = {
  sourceId: string;
  language: string;
  /** `draft` translates the source's unpublished changes. */
  version: "published" | "draft";
  /** Replaces a translation edited or written by hand; the modal asks first. */
  overwrite: boolean;
  slugs?: "translate" | "keep";
  /** Publishes the new draft; unset means Settings' `afterTranslate`. */
  publish?: boolean;
  instructions: string;
};

/** `overwrite` replaces a translation edited by hand since the result was paid for; the Studio asks first. */
export type ApplyInput = { sourceId: string; language: string; publish?: boolean; overwrite?: boolean };

export type LabelsInput = { ids?: string[]; languages?: string[]; publish?: boolean };

/** The `POST` body: one action per request. */
export type TranslateAction =
  | ({ action: "translate" } & PairInput)
  | ({ action: "apply" } & ApplyInput)
  | ({ action: "labels" } & LabelsInput)
  | { action: "relink"; publish: boolean }
  | { action: "publish"; ids: string[]; revs?: Record<string, string> }
  | ({ action: "link" } & LinkInput)
  | ({ action: "discard" } & DiscardInput);

export type PairStatus = "translated" | "skipped" | "busy" | "saved_result" | "refused" | "failed";

export type PairResult = {
  status: PairStatus;
  code?: TranslateCode;
  /** Fixed copy for a refusal or a failure (`{ error, code }`, as every API error). */
  error?: string;
  message?: string;
  sourceId: string;
  language: string;
  creditSpent: boolean;
  /** The server's re-check before spending. */
  previousStatus?: TranslationStatus;
  /** Recomputed after a write conflict. */
  statusNow?: TranslationStatus;
  targetId?: string;
  draftId?: string;
  uri?: string;
  created?: boolean;
  published?: boolean;
  stats?: MergeStats;
  keptPaths?: string[];
  guardedPaths?: string[];
  retryAfterSeconds?: number;
  usage?: { usageValue?: number; quota?: number };
  credits?: CreditsToday;
  drift?: string[];
  /** `unlinked_translation`: the document already in this language, to link instead. */
  unlinkedId?: string;
  durationMs: number;
};

export type LabelsResult = {
  status: "translated" | "skipped" | "busy" | "refused" | "failed";
  code?: TranslateCode;
  error?: string;
  message?: string;
  creditSpent: boolean;
  languages: string[];
  /** Ids written, each with its new names. */
  labels?: Record<string, Record<string, string>>;
  written?: string[];
  conflicts?: string[];
  /** Ids Sanity refused to write; their paid names are kept and written free by the next `labels` request. */
  failed?: string[];
  published?: string[];
  /** Category drafts this request created and left unpublished, with the revision it wrote: `publish` them with `revs`. */
  drafts?: Record<string, string>;
  /** Ids whose names failed the checks: left for a hand fix, never asked for again until the English name changes. */
  invalid?: string[];
  problems?: number;
  /** Labels still missing a language after this batch: the Studio loops. */
  remaining: number;
  retryAfterSeconds?: number;
  usage?: { usageValue?: number; quota?: number };
  credits?: CreditsToday;
  durationMs: number;
};

export type RelinkResult = {
  relinked: string[];
  /** Relinked and published, or a draft an earlier relink left, published once nothing else in it differs. */
  published: string[];
  conflicts: string[];
  /** Sanity refused the write; the next pass tries again. */
  failed?: string[];
  /** Not reached in this request: ask again. */
  remaining: number;
};

export type PublishSkipCode =
  | "no_draft"
  | "not_ai_translation"
  | "edited_by_hand"
  | "changed_since"
  | "publish_failed"
  | "out_of_time";

/** Fixed copy for each draft `publish` leaves alone. */
export const PUBLISH_SKIP_REASONS: Record<PublishSkipCode, string> = {
  no_draft: "No draft to publish.",
  not_ai_translation: "Not an AI translation.",
  edited_by_hand: "Edited since the AI wrote it, so it was left as a draft to review.",
  changed_since: "Changed since the AI run wrote it, so it was left as a draft to review.",
  publish_failed: "Sanity refused to publish it; open it in the Studio.",
  out_of_time: "Not reached in this request; publish again.",
};

export type PublishResult = { published: string[]; skipped: { id: string; reason: string; code?: PublishSkipCode }[] };

/** The most ids one `publish` request takes, and the most writes one relink pass makes; the Studio batches by it. */
export const FREE_PASS_BATCH = 50;

/** `labels_left_for_hand` when nothing is left to ask: how many names wait for a hand fix. */
export function labelsForHandMessage(count: number): string {
  const names = count === 1 ? "1 category name is" : `${count} category names are`;

  return `${names} left to fill in by hand. Fill ${count === 1 ? "it" : "them"} in, or change the English name and run again.`;
}

/** Free: links `targetId`, a document already written in `language`, as `sourceId`'s translation. `preview` writes nothing. */
export type LinkInput = { sourceId: string; language: string; targetId: string; preview?: boolean };

export type LinkResult = {
  status: "linked" | "preview" | "busy" | "refused";
  code?: TranslateCode;
  error?: string;
  message?: string;
  sourceId: string;
  language: string;
  targetId: string;
  /** The document's title or name, for the editor to confirm it is the same page or person. */
  title?: string;
  /** The translation group it joined, or created. */
  metadataId?: string;
  creditSpent: false;
};

/** Free: deletes the saved result of one pair, which nothing then offers to apply. */
export type DiscardInput = { sourceId: string; language: string };

export type DiscardResult = {
  status: "discarded" | "busy" | "refused";
  code?: TranslateCode;
  error?: string;
  message?: string;
  sourceId: string;
  language: string;
  creditSpent: false;
};

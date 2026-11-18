// Translate with AI's scratch documents in a language being removed: its paid results and timeout notes go, and its
// pending category names leave the labels result, so nothing writes that language back. See docs/features/ai-translation.md

import type { Mutation } from "@sanity/client";
import { AI_TRANSLATION_RESULT_TYPE } from "../../../sanity/constants";

export const AI_RESULTS_QUERY = `*[_type == "${AI_TRANSLATION_RESULT_TYPE}"]{
  _id,
  _rev,
  language,
  "timedOutLanguage": timedOut.language,
  result
}`;

export type AiResultDocument = {
  _id: string;
  _rev?: string;
  language?: unknown;
  timedOutLanguage?: unknown;
  result?: unknown;
};

export type AiResultCleanup = {
  deleteIds: string[];
  /** The labels result with the removed languages' pending names taken out, or `null` when nothing is left in it. */
  labels?: { id: string; rev?: string; result: string | null; names: number };
};

/** The labels pass's result: `language` is "all", never a locale. */
const LABELS_LANGUAGE = "all";

type SavedLabels = {
  pending?: Record<string, Record<string, unknown>>;
  rejected?: Record<string, unknown>;
  /** A person's paid fields in place, by `<id>:<language>`. */
  documents?: Record<string, unknown>;
  [key: string]: unknown;
};

function parseLabels(result: unknown): SavedLabels | undefined {
  try {
    const parsed: unknown = typeof result === "string" ? JSON.parse(result) : undefined;

    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SavedLabels) : undefined;
  } catch {
    return undefined;
  }
}

function stripLabels(document: AiResultDocument, removed: ReadonlySet<string>): AiResultCleanup["labels"] {
  const saved = parseLabels(document.result);

  if (!saved?.pending && !saved?.documents) {
    return undefined;
  }

  const documents = Object.fromEntries(
    Object.entries(saved.documents ?? {}).filter(([key]) => !removed.has(key.slice(key.lastIndexOf(":") + 1)))
  );
  let names = Object.keys(saved.documents ?? {}).length - Object.keys(documents).length;
  const pending = Object.fromEntries(
    Object.entries(saved.pending ?? {}).flatMap(([id, byLanguage]) => {
      const kept = Object.fromEntries(Object.entries(byLanguage ?? {}).filter(([language]) => !removed.has(language)));

      names += Object.keys(byLanguage ?? {}).length - Object.keys(kept).length;

      return Object.keys(kept).length > 0 ? [[id, kept]] : [];
    })
  );

  if (names === 0) {
    return undefined;
  }

  const left =
    Object.keys(pending).length > 0 || Object.keys(documents).length > 0 || Object.keys(saved.rejected ?? {}).length > 0;
  const pendingOnly = (map: unknown) =>
    Object.fromEntries(Object.entries(map ?? {}).filter(([id]) => Object.hasOwn(pending, id)));
  const result = { ...saved, pending, documents, fields: pendingOnly(saved.fields), sources: pendingOnly(saved.sources) };

  return { id: document._id, rev: document._rev, result: left ? JSON.stringify(result) : null, names };
}

export function planAiResultCleanup(documents: readonly AiResultDocument[], languages: readonly string[]): AiResultCleanup {
  const removed = new Set(languages);
  const inRemoved = (value: unknown) => typeof value === "string" && removed.has(value);
  const deleteIds = documents
    .filter((document) => inRemoved(document.language) || inRemoved(document.timedOutLanguage))
    .map(({ _id }) => _id)
    .sort();
  const labelsDocument = documents.find(({ language }) => language === LABELS_LANGUAGE);
  const labels = labelsDocument ? stripLabels(labelsDocument, removed) : undefined;

  return { deleteIds, ...(labels ? { labels } : {}) };
}

export function isEmptyCleanup(cleanup: AiResultCleanup): boolean {
  return cleanup.deleteIds.length === 0 && !cleanup.labels;
}

/** One transaction; the labels result is guarded by its revision, so a labels pass writing meanwhile fails it instead. */
export function aiResultCleanupMutations(cleanup: AiResultCleanup): Mutation[] {
  const { labels } = cleanup;
  const mutations: Mutation[] = cleanup.deleteIds.map((id) => ({ delete: { id } }));

  if (labels?.result === null) {
    mutations.push({ delete: { id: labels.id } });
  } else if (labels) {
    mutations.push({
      patch: { id: labels.id, ...(labels.rev ? { ifRevisionID: labels.rev } : {}), set: { result: labels.result } },
    });
  }

  return mutations;
}

export function describeAiResultCleanup(cleanup: AiResultCleanup): string[] {
  return [
    ...(cleanup.deleteIds.length > 0 ? [`Translate with AI: ${cleanup.deleteIds.length} saved results or timeout notes`] : []),
    ...(cleanup.labels ? [`Translate with AI: ${cleanup.labels.names} pending category names`] : []),
  ];
}

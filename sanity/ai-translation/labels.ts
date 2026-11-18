// Names translated in place (`LOCALIZED_FIELDS`): one `prompt` call per batch, every language at once, checked strictly.
// `prompt` is not schema-aware, so its JSON is never trusted: a name that fails the checks is left out, never written.

import type { PromptRequest } from "@sanity/client";
import { isPlainObject } from "./fields";
import type { TranslationLanguage } from "./style-guide";

export const LABEL_BATCH_SIZE = 50;
export const LABEL_MAX_LENGTH = 80;

export type LabelSource = { id: string; text: string };

export type LabelsPrompt = PromptRequest & { format: "json"; temperature: 0 };

/** Phrases the labels actually contain: `prompt` has no protected phrases of its own, so they go in the instruction. */
function phrasesIn(labels: readonly LabelSource[], phrases: readonly string[]): string[] {
  const texts = labels.map(({ text }) => text.toLowerCase());

  return phrases.filter((phrase) => texts.some((text) => text.includes(phrase.toLowerCase())));
}

export function buildLabelsPrompt(options: {
  labels: readonly LabelSource[];
  from: TranslationLanguage;
  to: readonly TranslationLanguage[];
  styleGuide?: string;
  protectedPhrases?: readonly string[];
}): LabelsPrompt {
  const { labels, from, to, styleGuide = "", protectedPhrases = [] } = options;

  if (labels.length === 0 || labels.length > LABEL_BATCH_SIZE || to.length === 0) {
    throw new Error(`[ai-translation] buildLabelsPrompt: send 1 to ${LABEL_BATCH_SIZE} labels and at least one language.`);
  }

  const example = { [labels[0]?.id as string]: Object.fromEntries(to.map(({ id, title }) => [id, `<the name in ${title}>`])) };
  const phrases = phrasesIn(labels, protectedPhrases);

  return {
    format: "json",
    temperature: 0,
    instruction: [
      "Translate each short category name in $labels from $from into each of these languages: $languages.",
      "They are labels on a website: keep them short, plain text, with no markup, quotes or explanations.",
      "Never translate these phrases, keep them exactly as written: $phrases.",
      "Follow this style guide: $styleGuide",
      "Answer with a JSON object only: one key per id in $labels, exactly those ids, each holding one string per language code.",
      `The JSON has this shape: ${JSON.stringify(example)}`,
    ].join("\n"),
    instructionParams: {
      labels: { type: "constant", value: JSON.stringify(Object.fromEntries(labels.map(({ id, text }) => [id, text]))) },
      from: { type: "constant", value: from.title },
      languages: { type: "constant", value: to.map(({ id, title }) => `${id} (${title})`).join(", ") },
      phrases: { type: "constant", value: phrases.length > 0 ? phrases.join(", ") : "(none)" },
      styleGuide: { type: "constant", value: styleGuide.trim() || "(none)" },
    },
  };
}

export type LabelsCheck = {
  ok: boolean;
  /** Only the ids whose every language passed; written with `setIfMissing`, never over an editor's text. */
  labels: Record<string, Record<string, string>>;
  /** Ids answered with names that failed: a language empty, too long, with markup, or another category's name. */
  invalid: string[];
  /** Ids an object answer left out or did not answer with one name per language: worth asking again. */
  missing: string[];
  problems: string[];
};

const MARKUP = /[<>`\p{Cc}]|\*\*|__|\]\(/u;

/** Also run on the English name: one that fails would fail translated too, so it is never sent. */
export function labelProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return "is empty";
  }

  if (value.trim().length > LABEL_MAX_LENGTH) {
    return `is longer than ${LABEL_MAX_LENGTH} characters`;
  }

  return MARKUP.test(value) ? "contains markup" : undefined;
}

function parse(result: unknown): unknown {
  if (typeof result !== "string") {
    return result;
  }

  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

/** Names shared across ids whose source names differ: one injected instruction can rename a whole batch alike. */
function sharedNames(
  labels: LabelsCheck["labels"],
  languages: readonly string[],
  sources: Readonly<Record<string, string>>
): Map<string, string> {
  const shared = new Map<string, string>();

  for (const language of languages) {
    const byName = new Map<string, string[]>();

    for (const [id, names] of Object.entries(labels)) {
      const name = (names[language] ?? "").toLowerCase();

      byName.set(name, [...(byName.get(name) ?? []), id]);
    }

    for (const ids of byName.values()) {
      const differ = new Set(ids.map((id) => (sources[id] ?? id).trim().toLowerCase())).size > 1;

      for (const id of differ ? ids : []) {
        shared.set(id, shared.get(id) ?? language);
      }
    }
  }

  return shared;
}

/** Exactly the ids asked for, one string per language asked for, short and plain; the problems never echo the model's text. */
export function validateLabelsResult(
  result: unknown,
  expected: {
    ids: readonly string[];
    languages: readonly string[];
    /** The source name of each id: two ids given one name although their sources differ both fail. */
    sources?: Readonly<Record<string, string>>;
  }
): LabelsCheck {
  const value = parse(result);
  const check: LabelsCheck = { ok: false, labels: {}, invalid: [], missing: [], problems: [] };

  // Not about any one name: none is parked for a hand fix, and every one is asked again.
  if (!isPlainObject(value)) {
    check.problems.push("The answer is not a JSON object.");

    return check;
  }

  const unexpected = Object.keys(value).filter((id) => !expected.ids.includes(id)).length;

  if (unexpected > 0) {
    check.problems.push(`The answer has ${unexpected} id(s) that were not asked for.`);
  }

  for (const id of expected.ids) {
    const entry = value[id];

    if (!isPlainObject(entry)) {
      check.problems.push(`"${id}" is missing.`);
      check.missing.push(id);
      continue;
    }

    const extra = Object.keys(entry).filter((language) => !expected.languages.includes(language));
    const leftOut = expected.languages.filter((language) => !Object.hasOwn(entry, language));
    const problems = expected.languages.flatMap((language) => {
      const problem = labelProblem(entry[language]);

      return problem ? [`"${id}" in ${language} ${problem}.`] : [];
    });

    if (extra.length > 0) {
      problems.push(`"${id}" has ${extra.length} language(s) that were not asked for.`);
    }

    if (problems.length > 0) {
      check.problems.push(...problems);
      // Languages left out and nothing else: no name was given to fail, so it is asked for again.
      (problems.length === leftOut.length ? check.missing : check.invalid).push(id);
      continue;
    }

    check.labels[id] = Object.fromEntries(expected.languages.map((language) => [language, (entry[language] as string).trim()]));
  }

  const shared = expected.sources ? sharedNames(check.labels, expected.languages, expected.sources) : new Map<string, string>();

  for (const id of expected.ids.filter((id) => shared.has(id))) {
    check.problems.push(`"${id}" in ${shared.get(id)} has the name of a category with another source name.`);
    check.invalid.push(id);
    delete check.labels[id];
  }

  check.ok = check.problems.length === 0;

  return check;
}

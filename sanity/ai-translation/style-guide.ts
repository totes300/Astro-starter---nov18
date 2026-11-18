// Settings > Translations read with its defaults, and compiled into the style guide and protected phrases one call carries.

import { AI_TRANSLATION_DEFAULTS, AI_TRANSLATION_STYLE_GUIDE_LIMIT } from "../constants";
import { isPlainObject } from "./fields";

/** What one run may add on top of the settings, checked on the server before anything is read. */
export const RUN_INSTRUCTIONS_LIMIT = 1000;

export type TranslationLanguage = { id: string; title: string };

export type BulkPolicy = "missing" | "refresh";

export type TranslationSettings = {
  styleGuide: string;
  protectedPhrases: string[];
  glossary: { term: string; renderings: Record<string, string> }[];
  languageNotes: Record<string, string>;
  defaults: {
    /** Empty means every language but the default. */
    languages: string[];
    policy: BulkPolicy;
    slugs: "translate" | "keep";
    afterTranslate: "draft" | "publish";
    maxCreditsPerRun: number;
    maxCreditsPerDay: number;
  };
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function texts(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith("_"))
      .map(([key, entry]): [string, string] => [key, text(entry)])
      .filter(([, entry]) => entry !== "")
  );
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** `siteSettings.translations` as published; an unset value means its default, so an older settings document still works. */
export function readTranslationSettings(raw: unknown): TranslationSettings {
  const settings = isPlainObject(raw) ? raw : {};
  const defaults = isPlainObject(settings.defaults) ? settings.defaults : {};

  return {
    styleGuide: text(settings.styleGuide),
    protectedPhrases: mergeProtectedPhrases(Array.isArray(settings.protectedPhrases) ? settings.protectedPhrases : []),
    glossary: (Array.isArray(settings.glossary) ? settings.glossary : [])
      .filter(isPlainObject)
      .map((entry) => ({ term: text(entry.term), renderings: texts(entry.renderings) }))
      .filter(({ term }) => term !== ""),
    languageNotes: texts(settings.languageNotes),
    defaults: {
      languages: [...new Set((Array.isArray(defaults.languages) ? defaults.languages : []).map(text).filter(Boolean))],
      policy: oneOf(defaults.policy, ["missing", "refresh"], AI_TRANSLATION_DEFAULTS.policy),
      slugs: oneOf(defaults.slugs, ["translate", "keep"], AI_TRANSLATION_DEFAULTS.slugs),
      afterTranslate: oneOf(defaults.afterTranslate, ["draft", "publish"], AI_TRANSLATION_DEFAULTS.afterTranslate),
      maxCreditsPerRun: positiveInteger(defaults.maxCreditsPerRun, AI_TRANSLATION_DEFAULTS.maxCreditsPerRun),
      maxCreditsPerDay: positiveInteger(defaults.maxCreditsPerDay, AI_TRANSLATION_DEFAULTS.maxCreditsPerDay),
    },
  };
}

/** Trimmed and de-duplicated in order: later lists add to earlier ones and never replace them. */
export function mergeProtectedPhrases(...lists: readonly (readonly unknown[] | null | undefined)[]): string[] {
  return [...new Set(lists.flatMap((list) => (list ?? []).map(text)).filter((phrase) => phrase !== ""))];
}

export function glossaryLines(settings: TranslationSettings, language: string): string[] {
  return settings.glossary.flatMap(({ term, renderings }) => {
    const rendering = renderings[language];

    return rendering ? [`Translate "${term}" as "${rendering}".`] : [];
  });
}

export type StyleGuidePart = { label: string; length: number };

export type StyleGuide =
  | { ok: true; styleGuide: string; length: number; remaining: number; parts: StyleGuidePart[] }
  | { ok: false; length: number; over: number; message: string; parts: StyleGuidePart[] };

const SEPARATOR = "\n\n";

function count(value: number): string {
  return value.toLocaleString("en");
}

/** The global guide, then this language's notes and glossary, then the run's own instructions, within Sanity's cap. */
export function buildStyleGuide(settings: TranslationSettings, language: TranslationLanguage, runInstructions = ""): StyleGuide {
  const sections = [
    { label: "style guide", text: settings.styleGuide },
    { label: `${language.title} notes`, text: settings.languageNotes[language.id] ?? "" },
    { label: "glossary", text: glossaryLines(settings, language.id).join("\n") },
    { label: "this run", text: text(runInstructions) },
  ].filter((section) => section.text !== "");
  const styleGuide = sections.map((section) => section.text).join(SEPARATOR);
  const parts = sections.map(({ label, text: value }) => ({ label, length: value.length }));
  const length = styleGuide.length;
  const over = length - AI_TRANSLATION_STYLE_GUIDE_LIMIT;

  if (over <= 0) {
    return { ok: true, styleGuide, length, remaining: AI_TRANSLATION_STYLE_GUIDE_LIMIT - length, parts };
  }

  const breakdown = parts.map(({ label, length: size }) => `${label} ${count(size)}`).join(", ");

  return {
    ok: false,
    length,
    over,
    parts,
    message: `The style guide for ${language.title} is ${count(length)} characters, ${count(over)} over Sanity's limit of ${count(AI_TRANSLATION_STYLE_GUIDE_LIMIT)} (${breakdown}). Shorten one of them.`,
  };
}

/** One message per language whose compiled guide is over the cap, for the Settings validation. */
export function styleGuideIssues(settings: TranslationSettings, languages: readonly TranslationLanguage[]): string[] {
  return languages.flatMap((language) => {
    const guide = buildStyleGuide(settings, language);

    return guide.ok ? [] : [guide.message];
  });
}

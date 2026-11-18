// The agent Markdown backfill's batching, pure so it runs under `node --test`.

import { isSharedRoutedType, sharedLocalePaths } from "~/features/i18n/shared-documents";
import { type Locale, splitLocalePrefix } from "~/sanity/i18n";

type BacklogVersion = { _id: string; _type?: string | null; uri?: string | null; missing?: boolean | null; arms?: unknown };

/** One Markdown to write: a version, the URL it serializes at, and the arm of a shared document's per-language text. */
export type BacklogTask = { _id: string; uri: string; language: Locale; arm?: Locale };

const isFilled = (value: unknown) => typeof value === "string" && value.trim() !== "";

/** The languages a version still lacks Markdown in: a shared document has one text per language, any other one. */
/** Shared, and its Markdown already one text per language (a plain string from before is read as any other page's). */
function hasArms(version: BacklogVersion): version is BacklogVersion & { _type: string } {
  return (
    isSharedRoutedType(version._type) && (version.arms === null || version.arms === undefined || typeof version.arms === "object")
  );
}

export function missingLanguages(version: BacklogVersion): Locale[] {
  const uri = version.uri ?? "/";

  if (hasArms(version)) {
    const arms = version.arms && typeof version.arms === "object" ? (version.arms as Record<string, unknown>) : {};

    return sharedLocalePaths(version._type, uri)
      .filter(({ language }) => !isFilled(arms[language]))
      .map(({ language }) => language);
  }

  return version.missing === true ? [splitLocalePrefix(uri).locale] : [];
}

export function backlogTasks(versions: readonly BacklogVersion[]): BacklogTask[] {
  return versions.flatMap((version) => {
    const uri = version.uri ?? "/";

    if (hasArms(version)) {
      const paths = new Map(sharedLocalePaths(version._type, uri).map(({ language, uri: path }) => [language, path]));

      return missingLanguages(version).map((language) => ({
        _id: version._id,
        uri: paths.get(language) ?? uri,
        language,
        arm: language,
      }));
    }

    return missingLanguages(version).map((language) => ({ _id: version._id, uri, language }));
  });
}

/** Each task's language from its own URI, as the per-page Generate reads it, so every read binds one `$language`. */
export function tasksByLocale(tasks: readonly BacklogTask[]): Map<Locale, BacklogTask[]> {
  const groups = new Map<Locale, BacklogTask[]>();

  for (const task of tasks) {
    groups.set(task.language, [...(groups.get(task.language) ?? []), task]);
  }

  return groups;
}

import type { SanityClient } from "@sanity/client";
import { isPlainObject } from "~/sanity/ai-translation/fields";
import type { TranslationLanguage, TranslationSettings } from "~/sanity/ai-translation/style-guide";
import type { SchemaCheck } from "~/sanity/ai-translation/wire";
import { DEFAULT_LOCALE, getLocaleTitle, isLocale, LOCALES } from "~/sanity/i18n";
import { SYSTEM_FIELDS, type TranslationDocument } from "~/sanity/translation-stub";

/** Kept for what must still land at a request's end: a pass's current item, or a paid result's save and write. */
export const WRITE_RESERVE_MS = 10_000;

export const RAW = { perspective: "raw" } as const;

/** A published id that also fits the dotted lease and result ids. */
const SOURCE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

export type Copies = { published?: TranslationDocument; draft?: TranslationDocument };

export function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function uriOf(document: Record<string, unknown> | undefined): string | undefined {
  const uri = document?.uri;

  return isPlainObject(uri) && typeof uri.current === "string" ? uri.current : undefined;
}

export function languagesOf(ids: readonly string[]): TranslationLanguage[] {
  return ids.map((id) => ({ id, title: getLocaleTitle(id) }));
}

export const SOURCE_LANGUAGE: TranslationLanguage = { id: DEFAULT_LOCALE, title: getLocaleTitle(DEFAULT_LOCALE) };

export const TARGET_LANGUAGES: readonly string[] = LOCALES.map(({ id }) => id).filter((id) => id !== DEFAULT_LOCALE);

export function isTargetLanguage(value: unknown): value is string {
  return isLocale(value) && value !== DEFAULT_LOCALE;
}

/** Settings' languages that are still configured; none left means every target, as an empty list does. */
export function defaultTargets(settings: TranslationSettings): string[] {
  const configured = settings.defaults.languages.filter(isTargetLanguage);

  return configured.length > 0 ? configured : [...TARGET_LANGUAGES];
}

export function isSourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID.test(value) && !/^(?:drafts|versions)\./.test(value);
}

export type TranslateDeps = {
  /** The edit client: every read goes through `fetchSanity`, every write is free. */
  client: SanityClient;
  /** From `createAgentClient`: the one client that spends AI credits. */
  agentClient: SanityClient;
  now?: () => Date;
  /** Read before the billed call only: once paid for, the result is always kept. */
  signal?: AbortSignal;
  /** Refuses a pair when the deployed schema has drifted. */
  schemaCheck?: () => Promise<SchemaCheck>;
  /** `PUBLIC_SITE_URL`: the origin a translation's agent Markdown links resolve against. */
  siteUrl: string;
  /** When the host ends the request (epoch ms): the AI call gets what is left after `WRITE_RESERVE_MS`. */
  deadline?: number;
  /** Where the host serves the Studio: a new translation's URI never lands there. */
  studioPaths?: readonly string[];
  /** Called as the billed call starts: a request that fails before it can answer that nothing was spent. */
  onBilledCall?: () => void;
};

export function revisionOf(documents: unknown, id: string): string | undefined {
  const list = Array.isArray(documents) ? documents : [];
  const document = [...list].reverse().find((entry) => isPlainObject(entry) && entry._id === id);

  return isPlainObject(document) && typeof document._rev === "string" ? document._rev : undefined;
}

export function draftOf(published: TranslationDocument): TranslationDocument {
  const draft: TranslationDocument = { ...structuredClone(published), _id: `drafts.${published._id}` };

  for (const field of SYSTEM_FIELDS) {
    delete draft[field];
  }

  return draft;
}

/** A throttle, a gateway failure or a dropped connection: Sanity may not have applied the write, and may on a resend. */
function isTransient(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;

  return typeof status !== "number" || [429, 502, 503, 504].includes(status);
}

/** For an idempotent write only (`createOrReplace`, `delete`): `@sanity/client` never retries a mutation itself. */
export async function retried<T>(write: () => Promise<T>, { attempts = 3, delayMs = 200 } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

export function pastDeadline(deadline: number | undefined): boolean {
  return deadline !== undefined && Date.now() > deadline - WRITE_RESERVE_MS;
}

import { isPlainObject } from "~/sanity/ai-translation/fields";
import { LABEL_BATCH_SIZE } from "~/sanity/ai-translation/labels";
import { RUN_INSTRUCTIONS_LIMIT } from "~/sanity/ai-translation/style-guide";
import { FREE_PASS_BATCH, type PairInput, type PlanRequest, type TranslateAction } from "~/sanity/ai-translation/wire";
import { isSourceId, isTargetLanguage } from "./shared";

/** A pair's request is small; anything near this is not the Studio talking. */
export const MAX_BODY_BYTES = 32_768;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parsePlanQuery(params: URLSearchParams): Parsed<PlanRequest> {
  const documentId = params.get("documentId") ?? undefined;
  const scope = params.get("scope");
  const languages = params
    .get("languages")
    ?.split(",")
    .map((language) => language.trim())
    .filter(Boolean);
  const policy = params.get("policy") ?? undefined;

  if (documentId === undefined && scope !== "site") {
    return { ok: false, error: "Ask for `documentId=<id>` or `scope=site`." };
  }

  if (documentId !== undefined && !isSourceId(documentId)) {
    return { ok: false, error: "`documentId` must be a published document id." };
  }

  if (languages && !languages.every(isTargetLanguage)) {
    return { ok: false, error: "`languages` lists a language this site does not translate into." };
  }

  if (policy !== undefined && policy !== "missing" && policy !== "refresh") {
    return { ok: false, error: "`policy` is `missing` or `refresh`." };
  }

  return {
    ok: true,
    value: {
      ...(documentId ? { documentId } : {}),
      useDraft: ["1", "true"].includes(params.get("useDraft") ?? ""),
      ...(languages?.length ? { languages } : {}),
      ...(policy ? { policy } : {}),
    },
  };
}

function optionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === "boolean" ? value : null;
}

function idList(value: unknown, max: number): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.length === 0 || value.length > max || !value.every(isSourceId)) {
    return null;
  }

  return [...new Set(value as string[])];
}

/** A Sanity revision id, as `_rev` reads. */
const REVISION = /^[A-Za-z0-9_-]{1,64}$/;

/** Generous: a body past 32 KiB is refused before this, and extra ids are ignored. */
const MAX_REVISIONS = 1000;

function revisionMap(value: unknown): Record<string, string> | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value);
  const valid = entries.every(([id, rev]) => isSourceId(id) && typeof rev === "string" && REVISION.test(rev));

  return valid && entries.length <= MAX_REVISIONS ? (Object.fromEntries(entries) as Record<string, string>) : null;
}

function parsePair(body: Record<string, unknown>): Parsed<PairInput> {
  const { sourceId, language, version = "published", overwrite = false, slugs, instructions = "" } = body;
  const publish = optionalBoolean(body.publish);

  if (!isSourceId(sourceId)) {
    return { ok: false, error: "`sourceId` must be the published id of the default language's document." };
  }

  if (!isTargetLanguage(language)) {
    return { ok: false, error: "`language` must be a configured language other than the default." };
  }

  if (version !== "published" && version !== "draft") {
    return { ok: false, error: "`version` is `published` or `draft`." };
  }

  if (typeof overwrite !== "boolean" || publish === null) {
    return { ok: false, error: "`overwrite` and `publish` are booleans." };
  }

  if (slugs !== undefined && slugs !== "translate" && slugs !== "keep") {
    return { ok: false, error: "`slugs` is `translate` or `keep`." };
  }

  if (typeof instructions !== "string" || instructions.length > RUN_INSTRUCTIONS_LIMIT) {
    return { ok: false, error: `\`instructions\` is text of at most ${RUN_INSTRUCTIONS_LIMIT} characters.` };
  }

  return {
    ok: true,
    value: {
      sourceId,
      language,
      version,
      overwrite,
      ...(slugs ? { slugs } : {}),
      ...(publish !== undefined ? { publish } : {}),
      instructions,
    },
  };
}

/** The POST body, checked before any read: one shape per action, every field capped. */
export function parseTranslateAction(text: string): Parsed<TranslateAction> {
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, error: "The request body is too large." };
  }

  let body: unknown;

  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "Send a JSON body." };
  }

  if (!isPlainObject(body)) {
    return { ok: false, error: "Send a JSON object." };
  }

  const publish = optionalBoolean(body.publish);

  switch (body.action) {
    case "translate": {
      const pair = parsePair(body);

      return pair.ok ? { ok: true, value: { action: "translate", ...pair.value } } : pair;
    }
    case "apply": {
      const overwrite = optionalBoolean(body.overwrite);

      if (!isSourceId(body.sourceId) || !isTargetLanguage(body.language) || publish === null || overwrite === null) {
        return {
          ok: false,
          error: "`apply` takes a `sourceId`, a target `language`, and optional `publish` and `overwrite` booleans.",
        };
      }

      return {
        ok: true,
        value: {
          action: "apply",
          sourceId: body.sourceId,
          language: body.language,
          ...(publish !== undefined ? { publish } : {}),
          ...(overwrite !== undefined ? { overwrite } : {}),
        },
      };
    }
    case "link": {
      const preview = optionalBoolean(body.preview);

      if (!isSourceId(body.sourceId) || !isTargetLanguage(body.language) || !isSourceId(body.targetId) || preview === null) {
        return {
          ok: false,
          error: "`link` takes a `sourceId`, a target `language`, the published `targetId` to link and an optional `preview`.",
        };
      }

      return {
        ok: true,
        value: {
          action: "link",
          sourceId: body.sourceId,
          language: body.language,
          targetId: body.targetId,
          ...(preview !== undefined ? { preview } : {}),
        },
      };
    }
    case "discard":
      return isSourceId(body.sourceId) && isTargetLanguage(body.language)
        ? { ok: true, value: { action: "discard", sourceId: body.sourceId, language: body.language } }
        : { ok: false, error: "`discard` takes a `sourceId` and a target `language`." };
    case "labels": {
      const ids = idList(body.ids, LABEL_BATCH_SIZE);
      const languages = body.languages;
      const validLanguages =
        languages === undefined || (Array.isArray(languages) && languages.length > 0 && languages.every(isTargetLanguage));

      if (ids === null || !validLanguages || publish === null) {
        return { ok: false, error: `\`labels\` takes up to ${LABEL_BATCH_SIZE} \`ids\`, target \`languages\` and \`publish\`.` };
      }

      return {
        ok: true,
        value: {
          action: "labels",
          ...(ids ? { ids } : {}),
          ...(languages ? { languages: [...new Set(languages as string[])] } : {}),
          ...(publish !== undefined ? { publish } : {}),
        },
      };
    }
    case "relink":
      return publish === null
        ? { ok: false, error: "`publish` is a boolean." }
        : { ok: true, value: { action: "relink", publish: publish ?? false } };
    case "publish": {
      const ids = idList(body.ids, FREE_PASS_BATCH);
      const revs = revisionMap(body.revs);

      return ids && revs !== null
        ? { ok: true, value: { action: "publish", ids, ...(revs ? { revs } : {}) } }
        : {
            ok: false,
            error: `\`publish\` takes 1 to ${FREE_PASS_BATCH} published \`ids\`, and optional \`revs\`: a revision by id.`,
          };
    }
    default:
      return { ok: false, error: "Unknown `action`." };
  }
}

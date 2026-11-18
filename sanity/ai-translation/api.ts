// The Studio's typed calls to the translate route: every failure, a host timeout page or a dropped connection
// included, comes back as a code and fixed copy an editor can read. The route: docs/features/ai-translation.md

import { sanityConfig } from "../config";
import type { StudioFetch } from "../lib/studio-fetch";
import { readStudioJson } from "../lib/studio-response";
import { AGENT_ERROR_MESSAGES } from "./agent-errors";
import { isPlainObject } from "./fields";
import { PUBLISH_ACCESS_TEXT } from "./present";
import {
  type ApplyInput,
  type DiscardInput,
  type DiscardResult,
  type LabelsInput,
  type LabelsResult,
  type LinkInput,
  type LinkResult,
  type PairInput,
  type PairResult,
  type PlanRequest,
  type PlanResponse,
  type PublishResult,
  type RelinkResult,
  type RouteErrorCode,
  TRANSLATE_MESSAGES,
  type TranslateAction,
  type TranslateCode,
} from "./wire";

/** The route's codes, plus the three only the Studio sees: no answer, a host's own error page, a cancelled request. */
type StudioErrorCode = TranslateCode | RouteErrorCode | "network" | "host_error" | "aborted";

export type ApiFailure<T = unknown> = {
  /** A `StudioErrorCode`, or a code a newer route sends as it is. */
  code: string;
  message: string;
  /** The HTTP status; 0 when no answer came back. */
  status: number;
  retryAfterSeconds?: number;
  /** The route said the call billed. */
  creditSpent: boolean;
  /** Billed, or may have: a billed call that timed out or lost its connection counts against a run's cap. */
  creditMayBeSpent: boolean;
  usage?: { usageValue?: number; quota?: number };
  /** The route's own answer when it sent one: a refused or failed pair still carries its details. */
  result?: T;
};

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure<T> };

export const STUDIO_MESSAGES = {
  network: "Could not reach the site. Check your connection, then try again.",
  host_error: "The site did not answer as expected. Try again in a moment.",
  aborted: "Cancelled. A request that already reached the site may still finish there.",
  slow: "The request took too long. Try again.",
  unauthorized: "Your Studio session has ended. Reload the Studio and sign in again.",
  forbidden: PUBLISH_ACCESS_TEXT,
  auth_unavailable: "Sanity could not confirm your session. Try again in a moment.",
  i18n_disabled: "Translating needs a second language. Ask a developer to add one to LOCALES in sanity/i18n.ts.",
  internal_error: "Sanity could not be read or written. Try again in a moment.",
} as const;

type CallOptions = {
  /** The call runs an Agent Action, so a lost answer may still count toward the organization's AI usage. */
  billable: boolean;
  fallback: string;
};

function messageFor(code: string): string | undefined {
  const messages: Record<string, string> = { ...STUDIO_MESSAGES, ...AGENT_ERROR_MESSAGES, ...TRANSLATE_MESSAGES };

  return Object.hasOwn(messages, code) ? messages[code] : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function seconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

function isTimeout(status: number): boolean {
  return status === 504 || status === 408;
}

/** The code of an answer that named none: a host's own page, or a gate in front of the route. */
function statusCode(status: number, hasBody: boolean): StudioErrorCode {
  if (status === 401) {
    return "unauthorized";
  }

  if (status === 403) {
    return "forbidden";
  }

  if (isTimeout(status)) {
    return "timeout";
  }

  return hasBody ? "unknown" : "host_error";
}

/** The gate's own wording is for developers; a 401 is the editor's session here, never the server's token. */
function sessionMessage(status: number, code: string): string | undefined {
  if (status === 401) {
    return STUDIO_MESSAGES.unauthorized;
  }

  if (status === 403) {
    return STUDIO_MESSAGES.forbidden;
  }

  return code === "auth_unavailable" ? STUDIO_MESSAGES.auth_unavailable : undefined;
}

/** A non-2xx answer, JSON or not, as one failure. */
export function toApiFailure<T>(res: Response, payload: unknown, options: CallOptions): ApiFailure<T> {
  const body = isPlainObject(payload) ? payload : undefined;
  const code = text(body?.code) ?? statusCode(res.status, body !== undefined);
  const creditSpent = body?.creditSpent === true;
  // A result says whether it billed; anything else from a billed call that died on the way may have.
  const reported = typeof body?.creditSpent === "boolean";
  const lost = !body || isTimeout(res.status) || res.status >= 500;
  const slowAndFree = !body && isTimeout(res.status) && !options.billable;
  const message =
    sessionMessage(res.status, code) ??
    (slowAndFree ? STUDIO_MESSAGES.slow : undefined) ??
    text(body?.error) ??
    text(body?.message) ??
    messageFor(code) ??
    options.fallback;
  const usage = isPlainObject(body?.usage) ? (body.usage as ApiFailure["usage"]) : undefined;
  const retryAfterSeconds = seconds(body?.retryAfterSeconds);

  return {
    code,
    message,
    status: res.status,
    creditSpent,
    creditMayBeSpent: creditSpent || (options.billable && !reported && lost),
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    ...(usage ? { usage } : {}),
    ...(body && "status" in body ? { result: body as T } : {}),
  };
}

/** No answer at all: offline, the site down, or the request cancelled. */
export function requestFailure<T>(error: unknown, signal: AbortSignal | undefined, options: CallOptions): ApiFailure<T> {
  const aborted = signal?.aborted === true || (error as { name?: unknown } | null)?.name === "AbortError";
  const code = aborted ? "aborted" : "network";

  return { code, message: STUDIO_MESSAGES[code], status: 0, creditSpent: false, creditMayBeSpent: options.billable };
}

async function call<T>(fetcher: StudioFetch, url: string, init: RequestInit, options: CallOptions): Promise<ApiResult<T>> {
  let res: Response;

  try {
    res = await fetcher(url, init);
  } catch (error) {
    return { ok: false, error: requestFailure<T>(error, init.signal ?? undefined, options) };
  }

  const payload = await readStudioJson<unknown>(res);

  if (res.ok && isPlainObject(payload)) {
    return { ok: true, data: payload as T };
  }

  return { ok: false, error: toApiFailure<T>(res, payload, options) };
}

function post<T>(fetcher: StudioFetch, body: TranslateAction, options: CallOptions, signal?: AbortSignal) {
  return call<T>(
    fetcher,
    sanityConfig.endpoints.aiTranslate,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal },
    options
  );
}

/** `?documentId=` for one document (its published id), `?scope=site` otherwise. */
export function planUrl(request: PlanRequest): string {
  const params = new URLSearchParams();

  if (request.documentId) {
    params.set("documentId", request.documentId);
  } else {
    params.set("scope", "site");
  }

  if (request.useDraft) {
    params.set("useDraft", "1");
  }

  if (request.languages?.length) {
    params.set("languages", request.languages.join(","));
  }

  if (request.policy) {
    params.set("policy", request.policy);
  }

  return `${sanityConfig.endpoints.aiTranslate}?${params}`;
}

/** No AI request: statuses, the estimate, AI requests made today and whatever would refuse a run. */
export function fetchPlan(fetcher: StudioFetch, request: PlanRequest, signal?: AbortSignal): Promise<ApiResult<PlanResponse>> {
  return call(fetcher, planUrl(request), { signal }, { billable: false, fallback: "The translation plan could not be read." });
}

/** One source into one language: one AI request, none when the route finds nothing to do. */
export function postTranslate(fetcher: StudioFetch, input: PairInput, signal?: AbortSignal): Promise<ApiResult<PairResult>> {
  return post(fetcher, { action: "translate", ...input }, { billable: true, fallback: "The translation failed." }, signal);
}

/** Free: writes the paid result a conflict or a failed write kept. */
export function applySaved(fetcher: StudioFetch, input: ApplyInput, signal?: AbortSignal): Promise<ApiResult<PairResult>> {
  return post(
    fetcher,
    { action: "apply", ...input },
    { billable: false, fallback: "The saved result could not be applied." },
    signal
  );
}

/** Free: deletes a saved result nobody will apply, so nothing offers it again. */
export function discardSaved(fetcher: StudioFetch, input: DiscardInput, signal?: AbortSignal): Promise<ApiResult<DiscardResult>> {
  return post(
    fetcher,
    { action: "discard", ...input },
    { billable: false, fallback: "The saved result could not be discarded." },
    signal
  );
}

/** Free: links a document already written in `language` as the translation; `preview` only checks it and answers its title. */
export function linkTranslation(fetcher: StudioFetch, input: LinkInput, signal?: AbortSignal): Promise<ApiResult<LinkResult>> {
  return post(fetcher, { action: "link", ...input }, { billable: false, fallback: "The document could not be linked." }, signal);
}

/** Category names: one AI request per call of up to 50; a person in place: one per language. Pass the ids of one plan batch. */
export function translateLabels(
  fetcher: StudioFetch,
  input: LabelsInput,
  signal?: AbortSignal
): Promise<ApiResult<LabelsResult>> {
  return post(fetcher, { action: "labels", ...input }, { billable: true, fallback: "The translation in place failed." }, signal);
}

/** Free, 50 translations per call: repeat while `remaining > 0`. */
export function relink(
  fetcher: StudioFetch,
  input: { publish?: boolean } = {},
  signal?: AbortSignal
): Promise<ApiResult<RelinkResult>> {
  return post(
    fetcher,
    { action: "relink", publish: input.publish === true },
    { billable: false, fallback: "Links could not be updated." },
    signal
  );
}

/** Free: publishes up to 50 drafts a run left; `revs` names each category draft's revision. */
export function publish(
  fetcher: StudioFetch,
  ids: string[],
  revs: Record<string, string> = {},
  signal?: AbortSignal
): Promise<ApiResult<PublishResult>> {
  return post(
    fetcher,
    { action: "publish", ids, ...(Object.keys(revs).length > 0 ? { revs } : {}) },
    { billable: false, fallback: "The translations could not be published." },
    signal
  );
}

/** What the run store calls; `createTranslateTransport` builds the real one, tests pass fakes. */
export type TranslateTransport = {
  translate(input: PairInput): Promise<ApiResult<PairResult>>;
  labels(input: LabelsInput): Promise<ApiResult<LabelsResult>>;
  relink(input: { publish?: boolean }): Promise<ApiResult<RelinkResult>>;
};

export function createTranslateTransport(fetcher: StudioFetch): TranslateTransport {
  return {
    translate: (input) => postTranslate(fetcher, input),
    labels: (input) => translateLabels(fetcher, input),
    relink: (input) => relink(fetcher, input),
  };
}

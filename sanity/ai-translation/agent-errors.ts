// Agent Action failures sorted into what the run does next. Sanity answers 429 for both a rate limit and a spent budget,
// and 404 for both a missing schema and a missing document, so the body tells them apart; upstream text never reaches a user.

import { isPlainObject } from "./fields";

export type AgentErrorCode =
  | "rate_limited"
  | "budget_exceeded"
  | "schema_missing"
  | "schema_rejected"
  | "document_not_found"
  | "invalid_request"
  | "unauthorized"
  | "server_error"
  | "timeout"
  | "unknown";

export type AgentError = {
  code: AgentErrorCode;
  status?: number;
  /** Set on a rate limit: how long every worker waits before the next call. */
  retryAfterSeconds?: number;
  /** Set on a budget stop when Sanity reports it. */
  usage?: { usageValue?: number; quota?: number };
  /** The call may have run and billed: never retried without the user, and counted in the day's ledger. */
  creditMayBeSpent: boolean;
  /** Free to retry automatically after `retryAfterSeconds`. */
  retryable: boolean;
};

/** Fixed copy per code: no upstream message is ever shown; the server logs it (`agentErrorLog`). */
export const AGENT_ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  rate_limited: "Sanity is rate limiting AI requests. Retrying shortly.",
  budget_exceeded: "Your organization reached its AI spending limit.",
  schema_missing: "Sanity AI cannot find the deployed schema. Ask a developer to run npm run sanity:schema-deploy.",
  schema_rejected:
    "Sanity AI refused the request over the deployed schema. Ask a developer to run npm run sanity:schema-deploy, then try again.",
  document_not_found: "Sanity AI could not find this document. Publish it, or translate its unpublished changes.",
  invalid_request:
    "Sanity AI refused the request. Ask a developer to look for its reason in the server log under [ai-translate].",
  unauthorized:
    "The server's Sanity token cannot run AI actions. Ask a developer to check that SANITY_API_EDIT_TOKEN is set and has Editor access.",
  server_error: "Sanity AI failed. It may still count toward your AI usage; nothing was saved.",
  timeout: "Timed out. It may still count toward your AI usage; nothing was saved.",
  unknown: "The AI request failed. It may still count toward your AI usage; nothing was saved.",
};

const DEFAULT_RETRY_SECONDS = 60;

/** Enough of Sanity's own words to diagnose a refusal from the server log, never a whole response. */
const LOGGED_TEXT_CHARS = 300;

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

type ErrorLike = {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  statusCode?: unknown;
  status?: unknown;
  responseBody?: unknown;
  response?: { body?: unknown; headers?: unknown; statusCode?: unknown };
};

function statusOf(error: ErrorLike): number | undefined {
  const status = [error.statusCode, error.response?.statusCode, error.status].find((value) => typeof value === "number");

  return typeof status === "number" ? status : undefined;
}

function bodyOf(error: ErrorLike): Record<string, unknown> {
  const body = error.response?.body ?? error.responseBody;

  if (isPlainObject(body)) {
    return body;
  }

  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);

      return isPlainObject(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

/** Every human-readable string the error carries, for matching only. */
function textsOf(error: ErrorLike, body: Record<string, unknown>): string {
  const nested = isPlainObject(body.error) ? body.error : {};

  return [error.message, body.message, body.error, body.description, nested.message, nested.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
}

function numberIn(body: Record<string, unknown>, key: string): number | undefined {
  const nested = isPlainObject(body.error) ? body.error : {};
  const value = body[key] ?? nested[key];

  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function retryAfter(error: ErrorLike, text: string): number {
  const headers = error.response?.headers;
  const header = isPlainObject(headers) ? (headers["retry-after"] ?? headers["Retry-After"]) : undefined;
  const fromHeader = Number(header);

  if (Number.isFinite(fromHeader) && fromHeader > 0) {
    return Math.ceil(fromHeader);
  }

  const fromText = /(\d+)\s*seconds?/i.exec(text)?.[1];

  return fromText ? Number(fromText) : DEFAULT_RETRY_SECONDS;
}

function isTimeout(error: ErrorLike): boolean {
  return error.name === "TimeoutError" || (typeof error.code === "string" && TIMEOUT_CODES.has(error.code));
}

export function classifyAgentError(error: unknown): AgentError {
  const candidate: ErrorLike = isPlainObject(error) ? error : {};
  const status = statusOf(candidate);
  const body = bodyOf(candidate);
  const text = textsOf(candidate, body);
  const base = { ...(status === undefined ? {} : { status }), creditMayBeSpent: false, retryable: false };

  if (isTimeout(candidate) || status === 408 || status === 504) {
    return { ...base, code: "timeout", creditMayBeSpent: true };
  }

  if (status === 429) {
    const usageValue = numberIn(body, "usageValue");
    const quota = numberIn(body, "quota");

    if (usageValue !== undefined || quota !== undefined || /budget|plan limit|spending limit|quota/i.test(text)) {
      return { ...base, code: "budget_exceeded", usage: { usageValue, quota } };
    }

    return { ...base, code: "rate_limited", retryable: true, retryAfterSeconds: retryAfter(candidate, text) };
  }

  if (status === 404) {
    return { ...base, code: /schema/i.test(text) ? "schema_missing" : "document_not_found" };
  }

  if (status === 401 || status === 403) {
    return { ...base, code: "unauthorized" };
  }

  // Only a refusal that names the schema is one a schema deploy can fix.
  if (status !== undefined && status >= 400 && status < 500) {
    return { ...base, code: /schema/i.test(text) ? "schema_rejected" : "invalid_request" };
  }

  if (status !== undefined && status >= 500) {
    return { ...base, code: "server_error", creditMayBeSpent: true };
  }

  return { ...base, code: "unknown", creditMayBeSpent: true };
}

/** The server log line for a failed call: its code, the HTTP status and Sanity's message, cut short. */
export function agentErrorLog(error: unknown, classified: AgentError = classifyAgentError(error)): string {
  const candidate: ErrorLike = isPlainObject(error) ? error : {};
  const text = textsOf(candidate, bodyOf(candidate)).replace(/\s+/g, " ").trim();
  const status = classified.status === undefined ? "no status" : `status ${classified.status}`;
  const detail = text.length > LOGGED_TEXT_CHARS ? `${text.slice(0, LOGGED_TEXT_CHARS)}...` : text;

  return `${classified.code} (${status})${detail ? `: ${detail}` : ""}`;
}

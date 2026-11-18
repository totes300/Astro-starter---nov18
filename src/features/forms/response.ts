import { basicAuthChallenge } from "~/features/auth/basic-auth";
import { uiStrings } from "~/features/i18n/strings";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import type { FormRequestVerdict } from "./request-guard";

/** A rejected parse answers with the whole map, not one sentence, so the browser can report it inline. */
export type FormFailure = { error?: string; fieldErrors?: Record<string, string | undefined> };

export type FormResponse = { ok: true } | ({ ok: false } & FormFailure);

export function formOk() {
  return Response.json({ ok: true } satisfies FormResponse);
}

export function formFailed(status: number, failure: FormFailure) {
  return Response.json({ ok: false, ...failure } satisfies FormResponse, { status });
}

// A refusal made before the body is read cannot know the page's locale, so the default answers it.

/** One answer per language for every request the form never sends, so it confirms nothing about which check failed. */
export function formRefused(locale: string = DEFAULT_LOCALE) {
  return formFailed(400, { error: uiStrings(locale).form.error });
}

/** Neither let through nor challenged: the lock is unreadable, or no credentials are set. */
export function formUnavailable(locale: string = DEFAULT_LOCALE) {
  const response = formFailed(503, { error: uiStrings(locale).form.closed });

  response.headers.set("Retry-After", "10");

  return response;
}

/** An aborted write may still land, so that visitor is told to wait rather than to send it again. */
export function formWriteFailed(error: unknown, locale: string) {
  const name = (error as { name?: unknown } | null)?.name;
  const strings = uiStrings(locale).form;

  if (name === "TimeoutError" || name === "AbortError") {
    return formFailed(504, { error: strings.submitUnconfirmed });
  }

  return formFailed(500, { error: strings.submitFailed });
}

/** The answer for a request the endpoint does not read; null when the verdict is to read the body. */
export function formRequestAnswer(verdict: FormRequestVerdict): Response | null {
  if (verdict === "ok") {
    return null;
  }

  // The pages' realm, so a browser already signed in to the site resends its credentials without asking.
  if (verdict === "auth") {
    return basicAuthChallenge();
  }

  if (verdict === "unavailable") {
    return formUnavailable();
  }

  return formRefused();
}

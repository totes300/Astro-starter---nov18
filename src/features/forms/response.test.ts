import assert from "node:assert/strict";
import { test } from "node:test";
import { UI_STRING_LOCALES, uiStrings } from "~/features/i18n/strings";
import { formRefused, formRequestAnswer, formUnavailable, formWriteFailed } from "./response";

test("formRefused is one generic 400 for every request the form never sends", async () => {
  const response = formRefused();

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: "Something went wrong. Please try again." });
});

test("a refusal made after the body is read answers in the posted language, with its generic error line", async () => {
  for (const locale of UI_STRING_LOCALES) {
    const refused = (await formRefused(locale).json()) as { error?: string };
    const unavailable = (await formUnavailable(locale).json()) as { error?: string };

    assert.equal(refused.error, uiStrings(locale).form.error, locale);
    assert.equal(unavailable.error, uiStrings(locale).form.closed, locale);
  }
});

test("formUnavailable is a 503 the form can report, with a retry hint", async () => {
  const response = formUnavailable();
  const body = (await response.json()) as { ok: boolean; error?: string };

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "10");
  assert.equal(body.ok, false);
  assert.ok(body.error);
});

test("formRequestAnswer: a verdict to read the body sends nothing back", () => {
  assert.equal(formRequestAnswer("ok"), null);
});

test("formRequestAnswer: a post without the site's credentials gets the pages' Basic challenge", async () => {
  const response = formRequestAnswer("auth");

  assert.equal(response?.status, 401);
  assert.equal(response?.headers.get("www-authenticate"), 'Basic realm="Protected"');
});

test("formRequestAnswer: an unreadable lock asks for a retry", () => {
  const response = formRequestAnswer("unavailable");

  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("retry-after"), "10");
});

test("formRequestAnswer: a wrong path or shape is the one generic 400", async () => {
  for (const verdict of ["path", "shape"] as const) {
    const response = formRequestAnswer(verdict);

    assert.equal(response?.status, 400, verdict);
    assert.equal(response?.headers.get("www-authenticate"), null, verdict);
    assert.deepEqual(await response?.json(), { ok: false, error: "Something went wrong. Please try again." }, verdict);
  }
});

test("formWriteFailed: a write that timed out may have landed, so the visitor is told to wait, not to resend", async () => {
  for (const error of [
    new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    new DOMException("x", "AbortError"),
  ]) {
    const response = formWriteFailed(error, "en");
    const { error: message } = (await response.json()) as { error?: string };

    assert.equal(response.status, 504);
    assert.match(message ?? "", /may have received this already/);
  }
});

test("formWriteFailed: any other failure asks for a later retry", async () => {
  for (const error of [new Error("Sanity answered 500"), new TypeError("fetch failed"), null, "x"]) {
    const response = formWriteFailed(error, "en");

    assert.equal(response.status, 500, String(error));
    assert.deepEqual(await response.json(), { ok: false, error: "Failed to submit form. Please try again later." });
  }
});

test("formWriteFailed answers in the posted language", async () => {
  const timeout = new DOMException("x", "TimeoutError");

  for (const locale of UI_STRING_LOCALES) {
    const { form } = uiStrings(locale);
    const unconfirmed = (await formWriteFailed(timeout, locale).json()) as { error?: string };
    const failed = (await formWriteFailed(new Error("x"), locale).json()) as { error?: string };

    assert.equal(unconfirmed.error, form.submitUnconfirmed, locale);
    assert.equal(failed.error, form.submitFailed, locale);
  }
});

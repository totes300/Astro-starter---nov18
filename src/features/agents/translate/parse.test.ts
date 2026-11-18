import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { parseTranslateAction } from "./parse";
import { responseStatus } from "./status";

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECOND: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const multi = { skip: !IS_I18N_ENABLED };
const parse = (body: Record<string, unknown>) => parseTranslateAction(JSON.stringify(body));

describe("parseTranslateAction, the free actions", () => {
  it("takes `link` with a published target id and an optional preview, and refuses anything else", multi, () => {
    assert.deepEqual(parse({ action: "link", sourceId: "about", language: SECOND, targetId: "chi-siamo", preview: true }), {
      ok: true,
      value: { action: "link", sourceId: "about", language: SECOND, targetId: "chi-siamo", preview: true },
    });

    for (const body of [
      { action: "link", sourceId: "about", language: SECOND },
      { action: "link", sourceId: "about", language: SECOND, targetId: "drafts.chi-siamo" },
      { action: "link", sourceId: "about", language: DEFAULT_LOCALE, targetId: "chi-siamo" },
      { action: "link", sourceId: "about", language: SECOND, targetId: "chi-siamo", preview: "yes" },
    ]) {
      assert.equal(parse(body).ok, false, JSON.stringify(body));
    }
  });

  it("takes `discard` for one pair, and `apply` with an overwrite flag", multi, () => {
    assert.deepEqual(parse({ action: "discard", sourceId: "about", language: SECOND }), {
      ok: true,
      value: { action: "discard", sourceId: "about", language: SECOND },
    });
    assert.deepEqual(parse({ action: "apply", sourceId: "about", language: SECOND, overwrite: true }), {
      ok: true,
      value: { action: "apply", sourceId: "about", language: SECOND, overwrite: true },
    });
    assert.equal(parse({ action: "discard", sourceId: "about", language: "zz" }).ok, false);
    assert.equal(parse({ action: "apply", sourceId: "about", language: SECOND, overwrite: "yes" }).ok, false);
  });
});

describe("responseStatus, the new answers", () => {
  it("answers 200 for a link, a preview and a discard, and keeps a status per new refusal", () => {
    for (const status of ["linked", "preview", "discarded"]) {
      assert.equal(responseStatus({ status }), 200, status);
    }

    for (const [code, status] of [
      ["needs_overwrite", 409],
      ["in_release", 409],
      ["link_taken", 409],
      ["link_mismatch", 409],
      ["link_not_found", 404],
      ["sanity_unavailable", 503],
    ] as const) {
      assert.equal(responseStatus({ status: "refused", code }), status, code);
    }
  });
});
